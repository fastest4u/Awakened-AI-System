import assert from "node:assert/strict";
import { fork, type ForkOptions } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";
import { createVerifiedReadAdapter } from "../src/orchestrator/verified-read/supervisor.js";
import { FreshStartAdmissionGuard } from "../src/orchestrator/fresh-start/fresh-start-admission.js";
import { makeActiveReadFixture } from "./support/v2-verified-read-fixture.js";
import type { VerifiedReadBinding } from "../src/orchestrator/verified-read/contracts.js";

const artifacts = ["v2.js", "v2-admin.js", "workers/project-store.worker.js",
  "internal/v2-internal-verified-read.js", "internal/v2-internal-verified-read-cleanup.js"];
const deployment = join(process.cwd(), "dist");
const measured = () => JSON.parse(readFileSync(join(deployment, "v2-build.json"), "utf8"));
const manifestDigest = (manifest: any) => {
  const { buildIdentityHash: _ignored, ...body } = manifest;
  return createHash("sha256").update(canonicalJson(body)).digest("hex");
};
async function comparisonMutation(entry: string, fault: "wrong-deployment" | "wrong-runtime", expectedHash: string) {
  const sourceUrl = new URL("../src/v2/build-identity.js", import.meta.url);
  let source = readFileSync(sourceUrl, "utf8");
  const guard = fault === "wrong-deployment" ? "manifest.deploymentId !== __V2_DEPLOYMENT_ID__"
    : "runtime.nodeVersion !== process.versions.node";
  assert.equal(source.split(guard).length, 2, "mutation must remove exactly the intended compiled production comparison");
  source = source.replace(guard, "false").replace(/from (["'])(\.[^"']+)\1/g,
    (_match, _quote, relative) => `from ${JSON.stringify(new URL(relative, sourceUrl).href)}`);
  source = `const __V2_DEPLOYMENT_ID__=${JSON.stringify(measured().deploymentId)};\n${source}`;
  const inspector = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  // This is a narrowly mutated inspector over genuine artifact bytes, never a
  // fabricated positive deployment/child claim. All other checks remain real.
  assert.equal(inspector.inspectV2Build(pathToFileURL(entry).href), expectedHash,
    "another mismatch masked the targeted identity comparison");
}
async function fixture(buildHash = measured().buildIdentityHash) {
  const f = await makeActiveReadFixture(buildHash);
  try {
    for (const name of [...artifacts, "v2-build.json"]) {
      const target = join(f.binding.deploymentDirectory.canonicalPath, name);
      mkdirSync(dirname(target), { recursive: true }); cpSync(join(deployment, name), target);
    }
    const canonicalPath = join(f.binding.deploymentDirectory.canonicalPath, "internal");
    const stat = lstatSync(canonicalPath, { bigint: true });
    const binding: VerifiedReadBinding = { ...f.binding, deploymentDirectory: { canonicalPath, device: String(stat.dev), inode: String(stat.ino) } };
    return { ...f, binding, copied: f.binding.deploymentDirectory.canonicalPath };
  } catch (error) { f.cleanup(); throw error; }
}
async function ipc(entry: string, cwd: string, input: object) {
  const child = fork(entry, [], { cwd, execArgv: [], windowsHide: true, env: process.platform === "win32"
    ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR } : {}, stdio: ["ignore", "pipe", "pipe", "ipc"] } as ForkOptions);
  const messages: any[] = []; let stdout = "", stderr = "";
  child.on("message", value => messages.push(value)); child.stdout!.on("data", value => stdout += value); child.stderr!.on("data", value => stderr += value);
  const closed = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
  try { child.send(input); const code = await closed; return { messages, code, stdout, stderr }; }
  finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await closed; } }
}
const ids = { requestId: "entry-test", attemptId: "attempt-test", laneEpoch: "fixture-epoch" };
function input(f: Awaited<ReturnType<typeof fixture>>, kind: "read" | "cleanup", hash = f.measuredBuildHash) {
  return kind === "read" ? { version: 1, ids, binding: { ...f.binding, expectedRelease: { ...f.release, buildIdentityHash: hash } },
    request: f.request, lockToken: "a".repeat(32), remainingMs: 5000 }
    : { version: 1, ids, directory: f.binding.projectionDirectory, lockToken: "a".repeat(32), expectedBuildHash: hash, remainingMs: 2000 };
}

// Omitting either bundle from the build/identity breaks the actual deployment here.
test("all five measured artifacts exist in exact order and both isolated closures exclude subprocess/thread APIs", () => {
  const manifest = measured(); assert.deepEqual(manifest.artifacts.map((value: any) => value.path), artifacts);
  for (const name of artifacts) assert.ok(existsSync(join(deployment, name)), `missing measured artifact ${name}`);
  for (const name of artifacts.slice(3)) {
    const closure = JSON.parse(readFileSync(join(deployment, `${name}.closure.json`), "utf8"));
    assert.ok(closure.inputs.some((value: any) => value.path.startsWith("src/orchestrator/verified-read/")));
    assert.equal(closure.artifact.sha256, manifest.artifacts.find((value: any) => value.path === name).sha256);
    assert.ok(!closure.runtimeImports.some((value: string) => /^(node:)?(child_process|worker_threads)$/.test(value)));
    assert.equal(closure.sourceChecked, true); assert.equal(closure.emittedChecked, true);
  }
});

test("real measured supervisor verifies genesis, later publication and reopen with closed ownership and public denial", { timeout: 25000 }, async () => {
  const f = await fixture(); let adapter = createVerifiedReadAdapter(f.binding);
  try {
    const genesis = await adapter.verify(f.request); assert.equal(genesis.projectionEventPosition, "0");
    assert.equal(genesis.projectionEventHash, "0".repeat(64)); assert.equal(genesis.scope.storeId, f.identity.storeId);
    assert.equal(Object.hasOwn(genesis, "content"), false);
    assert.equal(existsSync(join(f.binding.executorStateDirectory.canonicalPath, "verified-read-owner.json")), false);
    assert.equal(existsSync(join(f.binding.projectionDirectory.canonicalPath, ".projection-manifest.publish.lock")), false);
    const event = f.append(); const manifest = await f.publish();
    const later = await adapter.verify(f.request); assert.equal(later.projectionEventPosition, event.position);
    assert.equal(later.projectionEventHash, event.hash); assert.equal(later.projectionGeneration, manifest.generation);
    assert.equal((await adapter.close()).cleanup, "complete");
    adapter = createVerifiedReadAdapter({ ...f.binding, compositionEpoch: "reopened" });
    assert.equal((await adapter.verify(f.request)).projectionEventPosition, "1");
    assert.throws(() => new FreshStartAdmissionGuard(f.writer).assertRequestAllowed({ identity: f.identity,
      releaseId: f.release.releaseId, generation: 1n, measuredBuildHash: f.measuredBuildHash, operation: "content-read" }), { code: "FRESH_START_CONTENT_UNVERIFIED" });
    assert.equal(f.writer.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()!.busy, 0n);
  } finally { await adapter.close(); f.cleanup(); }
});

for (const target of ["disabled", "prepared", "read-only-recovery"] as const) test(`measured children enforce ${target} fencing`, async () => {
  const f = await fixture(); const adapter = createVerifiedReadAdapter(f.binding);
  try {
    f.control.stop({ identity: f.identity, expectedGeneration: 1n, target: target === "prepared" ? "disabled" : target, reasonCode: "integrity-failure" });
    if (target === "prepared") await f.control.transition({ identity: f.identity, expectedGeneration: 2n, expectedMode: "disabled",
      expectedReleaseId: f.release.releaseId, nextMode: "prepared", nextRelease: f.release, approvalEnvelope: new Uint8Array([1]) });
    await assert.rejects(adapter.verify(f.request), { code: target === "read-only-recovery" ? "FRESH_START_CONTENT_UNVERIFIED" : "FRESH_START_ADMISSION_DENIED" });
    assert.equal((await adapter.close()).cleanup, "complete");
  } finally { await adapter.close(); f.cleanup(); }
});

for (const child of ["read", "cleanup"] as const) {
  test(`${child} entry independently measures the deployment and refuses a parent-only hash echo and unbundled entry`, async () => {
    const f = await fixture();
    try {
      const file = `v2-internal-verified-read${child === "cleanup" ? "-cleanup" : ""}.js`;
      const good = await ipc(join(f.binding.deploymentDirectory.canonicalPath, file), f.binding.projectionDirectory.canonicalPath, input(f, child));
      assert.equal(good.code, 0, good.stderr); assert.equal(good.messages.at(-1).kind, child === "read" ? "success" : "cleanup");
      if (child === "cleanup") assert.equal(good.messages.at(-1).cleanup, "complete");
      const unbundled = fileURLToPath(new URL(`../src/v2/internal-verified-read${child === "cleanup" ? "-cleanup" : ""}.entry.js`, import.meta.url));
      const value = await ipc(unbundled, f.binding.projectionDirectory.canonicalPath, input(f, child));
      assert.equal(value.messages.at(-1).kind, child === "read" ? "failure" : "cleanup");
      if (child === "read") assert.equal(value.messages.at(-1).failure.code, "FRESH_START_BUILD_MISMATCH");
      else assert.equal(value.messages.at(-1).cleanup, "incomplete");
    } finally { f.cleanup(); }
    // The wrong parent hash also matches real stored authority. Only independent
    // inspection of the unchanged measured bundles can reject this composition.
    const echo = await fixture("f".repeat(64));
    try {
      const file = `v2-internal-verified-read${child === "cleanup" ? "-cleanup" : ""}.js`;
      const value = await ipc(join(echo.binding.deploymentDirectory.canonicalPath, file), echo.binding.projectionDirectory.canonicalPath, input(echo, child));
      assert.equal(value.messages.at(-1).kind, child === "read" ? "failure" : "cleanup");
      if (child === "read") { assert.equal(value.messages.at(-1).failure.code, "FRESH_START_BUILD_MISMATCH"); assert.equal(value.messages.filter(value => value.kind === "stage").length, 0); }
      else assert.equal(value.messages.at(-1).cleanup, "incomplete");
    } finally { echo.cleanup(); }
  });
  for (const fault of ["missing", "tampered", "wrong-deployment", "wrong-runtime", "wrong-build"] as const) test(`${child} independently refuses ${fault} copied deployment`, async () => {
    const negative = measured();
    if (fault === "wrong-deployment") negative.deploymentId = "11111111-1111-4111-8111-111111111111";
    if (fault === "wrong-runtime") negative.runtime.nodeVersion = "0.0.0";
    if (fault === "wrong-deployment" || fault === "wrong-runtime") negative.buildIdentityHash = manifestDigest(negative);
    // Real synthetic stored/request authority agrees with the forged negative
    // digest, so neither stale digest nor admission mismatch can mask refusal.
    const f = await fixture(fault === "wrong-deployment" || fault === "wrong-runtime" ? negative.buildIdentityHash : measured().buildIdentityHash);
    try {
      const file = `internal/v2-internal-verified-read${child === "cleanup" ? "-cleanup" : ""}.js`;
      // Run the other entry for a missing/tampered child: both entries must measure all five artifacts.
      const entry = join(f.copied, fault === "missing" || fault === "tampered"
        ? `internal/v2-internal-verified-read${child === "read" ? "-cleanup" : ""}.js` : file);
      const running = fault === "missing" || fault === "tampered" ? child === "read" ? "cleanup" : "read" : child;
      if (fault === "missing") unlinkSync(join(f.copied, file));
      else if (fault === "tampered") writeFileSync(join(f.copied, file), readFileSync(join(f.copied, file), "utf8") + "\n// owned tamper\n");
      else {
        const manifest = negative;
        if (fault === "wrong-build") manifest.buildIdentityHash = "f".repeat(64);
        writeFileSync(join(f.copied, "v2-build.json"), JSON.stringify(manifest));
      }
      const value = await ipc(entry, f.binding.projectionDirectory.canonicalPath, input(f, running));
      if (running === "read") assert.equal(value.messages.at(-1).failure.code, "FRESH_START_BUILD_MISMATCH");
      else assert.equal(value.messages.at(-1).cleanup, "incomplete");
      if (fault === "wrong-deployment" || fault === "wrong-runtime") {
        assert.equal(value.messages.filter(message => message.kind === "stage").length, 0);
        assert.equal(existsSync(join(f.binding.executorStateDirectory.canonicalPath, "verified-read-owner.json")), false);
        assert.equal(existsSync(join(f.binding.projectionDirectory.canonicalPath, ".projection-manifest.publish.lock")), false);
        for (const name of artifacts) assert.deepEqual(readFileSync(join(f.copied, name)), readFileSync(join(deployment, name)));
        await comparisonMutation(entry, fault, f.measuredBuildHash);
      }
    } finally { f.cleanup(); }
  });
}
