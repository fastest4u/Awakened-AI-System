import assert from "node:assert/strict";
import { test } from "node:test";
import fs, { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { executeVerifiedRead, type VerifiedReadChildDependencies } from "../src/orchestrator/verified-read/child.js";
import { decodeReadBootstrap, decodeReadReply } from "../src/orchestrator/verified-read/protocol.js";
import type { ReadReply, ReadBootstrap, ReadTerminalReply } from "../src/orchestrator/verified-read/contracts.js";
import { makeNativeContentFixture, nativeGetRequest, nativeSearchRequest } from "./support/v2-native-content-fixture.js";

const lock = ".projection-manifest.publish.lock";
type Fixture = Awaited<ReturnType<typeof makeNativeContentFixture>>;
async function fixture(run: (f: Fixture, id: string, position: string, manifest: Awaited<ReturnType<Fixture["publish"]>>) => Promise<void>) {
  const f = await makeNativeContentFixture(); const cwd = process.cwd();
  try {
    const corpus = await f.appendCorpus(); const manifest = await f.publish();
    process.chdir(f.binding.projectionDirectory.canonicalPath);
    await run(f, corpus.ids.canonical, corpus.sourcePositions.canonical, manifest);
  } finally {
    process.chdir(cwd);
    if (existsSync(join(f.binding.projectionDirectory.canonicalPath, lock))) {
      // A foreign/unreleased token is retained even in the direct-child synthetic fixture.
      f.reader.close(); f.writer.close(); console.error(`Retained unresolved child lock fixture: ${f.root}`);
    } else f.cleanup();
  }
}
function controls(f: Fixture, onStage: (reply: Extract<ReadReply, { kind: "stage" }>) => void = () => {}) {
  let now = 0; const stages: string[] = [];
  const deps: VerifiedReadChildDependencies = { inspectBuild: () => f.measuredBuildHash, now: () => now,
    wait: async () => {}, signal: new AbortController().signal,
    emitStage(reply) { stages.push(reply.phase); onStage(reply); } };
  return { deps, stages, advance: (ms: number) => { now += ms; } };
}
function boot(f: Fixture, id: string): ReadBootstrap {
  return decodeReadBootstrap({ version: 2, ids: { requestId: "content", attemptId: "attempt", laneEpoch: "fixture-epoch" },
    binding: f.binding, request: nativeGetRequest(id), lockToken: "b".repeat(32), remainingMs: 5000 });
}
function failure(reply: ReadTerminalReply, code: string, cleanup = "complete") {
  assert.equal(reply.kind, "failure"); if (reply.kind === "failure") { assert.equal(reply.failure.code, code); assert.equal(reply.failure.cleanup, cleanup); }
}
function stop(f: Fixture) { f.control.stop({ identity: f.identity, expectedGeneration: 1n,
  target: "read-only-recovery", reasonCode: "integrity-failure" }); }

// Catches reopening the published pathname after capture or omitting final authority validation.
test("child_queries_same_image_and_final_authority", async () => fixture(async (f, id, sourcePosition, manifest) => {
  const c = controls(f, reply => {
    if (reply.phase === "query") {
      assert.equal(readFileSync(lock, "utf8"), "b".repeat(32));
      renameSync(manifest.databaseFile, "captured-original.sqlite");
      writeFileSync(manifest.databaseFile, "replacement-path-is-not-the-image");
      f.append(); // later ordinary commits do not move the captured fence
    }
  });
  const reply = decodeReadReply(await executeVerifiedRead(boot(f, id), c.deps));
  assert.equal(reply.kind, "success");
  if (reply.kind === "success" && reply.receipt.operation === "get-canonical-record" && reply.content?.operation === "get-canonical-record") {
    assert.equal(reply.content.item?.id, id); assert.equal(reply.content.item?.text, "native canonical projected summary");
    assert.equal(reply.content.item?.sourceEventPosition, sourcePosition);
    assert.equal(reply.receipt.projectionEventPosition, manifest.terminalEventPosition);
    assert.equal(Object.isFrozen(reply.content.item), true);
  } else assert.fail("exact get content required");
  assert.deepEqual(c.stages, ["admission", "projection-wait", "capture", "validate", "query", "revalidate"]);
  assert.equal(existsSync(lock), false);
}));

for (const fault of ["sha", "metadata", "source-anchor", "transition", "image-close", "lock-release", "reader-close", "query-budget", "packing-budget"] as const) {
  test(`content refuses independently isolated ${fault} failure`, async () => fixture(async (f, id, _position, manifest) => {
    const originalClose = DatabaseSync.prototype.close, originalRead = fs.readFileSync;
    if (fault === "sha") { const bytes = readFileSync(manifest.databaseFile); bytes[100] = bytes[100]! ^ 1; writeFileSync(manifest.databaseFile, bytes); }
    if (fault === "metadata") {
      const db = new DatabaseSync(manifest.databaseFile); try { db.exec("UPDATE projection_metadata SET generation=123"); } finally { db.close(); }
      writeFileSync("projection-manifest.json", JSON.stringify({ ...manifest, databaseSha256: createHash("sha256").update(readFileSync(manifest.databaseFile)).digest("hex") }));
    }
    if (fault === "source-anchor") {
      const db = new DatabaseSync(manifest.databaseFile);
      try { db.exec("UPDATE projection_metadata SET terminal_event_hash='" + "f".repeat(64) + "'"); } finally { db.close(); }
      writeFileSync("projection-manifest.json", JSON.stringify({ ...manifest, terminalEventHash: "f".repeat(64),
        databaseSha256: createHash("sha256").update(readFileSync(manifest.databaseFile)).digest("hex") }));
    }
    const c = controls(f, reply => {
      if (reply.phase === "query") {
        if (fault === "transition") stop(f);
        if (fault === "lock-release") writeFileSync(lock, "c".repeat(32));
        if (fault === "query-budget") c.advance(5000);
      }
      if (reply.phase === "revalidate" && fault === "packing-budget") c.advance(5000);
    });
    if (fault === "image-close" || fault === "reader-close") DatabaseSync.prototype.close = function () {
      const memory = this.prepare("PRAGMA database_list").get()!.file === "";
      originalClose.call(this);
      if ((fault === "image-close") === memory) throw new Error("synthetic actual close failure");
    };
    try {
      const reply = await executeVerifiedRead(boot(f, id), c.deps);
      const code = fault === "metadata" ? "PROJECTION_SCOPE_MISMATCH" : fault === "transition" ? "FRESH_START_CONTENT_UNVERIFIED"
        : fault === "lock-release" ? "PROJECTION_PATH_INVALID" : fault.endsWith("budget") ? "WORKER_TIMEOUT"
        : fault.endsWith("close") ? "WORKER_UNAVAILABLE" : "INTEGRITY_FAILURE";
      failure(reply, code, fault.endsWith("close") || fault === "lock-release" ? "incomplete" : "complete");
    } finally { DatabaseSync.prototype.close = originalClose; fs.readFileSync = originalRead; syncBuiltinESMExports(); }
  }));
}

test("content final authority observation fences a transition and permits later transition", async () => fixture(async (f, id) => {
  const original = DatabaseSync.prototype.close; let stopped = false;
  DatabaseSync.prototype.close = function () { const file = this.prepare("PRAGMA database_list").get()!.file;
    original.call(this); if (file) { stop(f); stopped = true; } };
  try { const reply = await executeVerifiedRead(boot(f, id), controls(f).deps); assert.equal(stopped, true); assert.equal(reply.kind, "success"); }
  finally { DatabaseSync.prototype.close = original; }
}));

test("metadata uses five phases while content search uses six and preserves actual text", async () => fixture(async (f, id) => {
  const c = controls(f); const reply = await executeVerifiedRead({ ...boot(f, id), request: nativeSearchRequest() }, c.deps);
  assert.equal(reply.kind, "success"); if (reply.kind === "success" && reply.content?.operation === "search-projected-content") {
    assert.ok(reply.content.items.some(item => item.id === id && item.text === "native canonical projected summary"));
  } else assert.fail("search content required");
  const m = controls(f); assert.equal((await executeVerifiedRead({ ...boot(f, id), request: f.request }, m.deps)).kind, "success");
  assert.deepEqual(m.stages, ["admission", "projection-wait", "capture", "validate", "revalidate"]);
}));
