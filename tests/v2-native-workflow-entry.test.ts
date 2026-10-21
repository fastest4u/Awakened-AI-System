import assert from "node:assert/strict";
import test from "node:test";
import { decodeReadBootstrap, decodeReadCancel, decodeReadReply, decodeCleanupBootstrap, verifiedReadFailure } from "../src/orchestrator/verified-read/protocol.js";
import { readBootstrap, READ_HASH } from "./support/v2-verified-read-fixture.js";

test("read_wire3_accepts_and_wire2_refuses", () => {
  for (const operation of ["verify-published-view", "search-projected-content", "get-canonical-record", "list-canonical-records", "recent-canonical-records", "build-context-pack", "follow-up-radar"]) {
    const base = readBootstrap(); const parameters = operation === "get-canonical-record" ? { id: "record" } : operation === "search-projected-content" || operation === "build-context-pack" ? { query: "native" } : {};
    const request = { ...base.request, operation, ...(operation === "verify-published-view" ? {} : { parameters }) };
    assert.equal(decodeReadBootstrap({ ...base, version: 3, request }).version, 3);
    for (const version of [1, 2, "3"]) assert.throws(() => decodeReadBootstrap({ ...base, version, request }), { code: "FRESH_START_INPUT_INVALID" });
  }
  const ids = readBootstrap().ids;
  assert.equal(decodeReadCancel({ version: 3, ids, kind: "cancel" }).version, 3);
  assert.equal(decodeReadReply({ version: 3, ids, kind: "failure", failure: { code: "V2_CONTENT_CURSOR_STALE", cleanup: "incomplete", positions: null } }).version, 3);
  assert.equal(verifiedReadFailure(Object.assign(new Error("V2_CONTENT_CURSOR_STALE"), { code: "V2_CONTENT_CURSOR_STALE", cleanup: "incomplete" })).code, "V2_CONTENT_CURSOR_STALE");
  for (const version of [1, 2, "3"]) {
    assert.throws(() => decodeReadCancel({ version, ids, kind: "cancel" }), { code: "FRESH_START_INPUT_INVALID" });
    assert.throws(() => decodeReadReply({ version, ids, kind: "stage", phase: "query", observedProjectionPosition: null }), { code: "FRESH_START_INPUT_INVALID" });
  }
  assert.equal(decodeCleanupBootstrap({ version: 1, ids, directory: readBootstrap().binding.projectionDirectory, lockToken: "a".repeat(32), expectedBuildHash: READ_HASH, remainingMs: 2000 }).version, 1);
});

import { createHash } from "node:crypto";
import { command } from "./fixtures/fresh-start-admission-child.js";
import { FRESH_NOW } from "./support/fresh-start-fixture.js";
import { nativeWorkflowReceipt } from "./support/v2-native-workflow-fixture.js";
import { queryNativeContent } from "../src/orchestrator/verified-read/content-query.js";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { executeVerifiedRead } from "../src/orchestrator/verified-read/child.js";
import { createVerifiedReadAdapter } from "../src/orchestrator/verified-read/supervisor.js";
import { VerifiedReadOwnershipRepository } from "../src/orchestrator/verified-read/ownership.js";
import { deployMeasuredNativeFixture, makeNativeContentFixture, NATIVE_SESSION } from "./support/v2-native-content-fixture.js";
import type { NativeWorkflowRequest } from "../src/orchestrator/verified-read/workflow-contracts.js";
const workflowRequest = (operation: NativeWorkflowRequest["operation"]): NativeWorkflowRequest => ({ operation, consistency: "project-strong", minimumEventPosition: "0", budgetMs: 5000,
  parameters: operation === "build-context-pack" ? { query: "no-ranked-match" } : { limit: 5 } } as NativeWorkflowRequest);

test("context_same_captured_image_and_final_authority", async () => {
  for (const stale of [false, true]) {
    const f = await makeNativeContentFixture(READ_HASH, { session: { sessionId: NATIVE_SESSION, minimumEventPosition: "0" } }); const cwd = process.cwd();
    try {
      const corpus = await f.appendCorpus(); const manifest = await f.publish();
      const sha = createHash("sha256").update(readFileSync(join(f.binding.projectionDirectory.canonicalPath, manifest.databaseFile))).digest("hex");
      process.chdir(f.binding.projectionDirectory.canonicalPath);
      const bootstrap = decodeReadBootstrap({ version: 3, ids: readBootstrap().ids, binding: f.binding, request: { ...workflowRequest("build-context-pack"), parameters: { query: "native canonical" } }, lockToken: "b".repeat(32), remainingMs: 5000 });
      const phases: string[] = [];
      const reply = await executeVerifiedRead(bootstrap, { inspectBuild: () => f.measuredBuildHash, now: () => 0, wait: async () => {}, signal: new AbortController().signal,
        emitStage(stage) { phases.push(stage.phase); if (stage.phase === "query") {
          assert.equal(readFileSync(".projection-manifest.publish.lock", "utf8"), "b".repeat(32));
          renameSync(manifest.databaseFile, "captured-original.sqlite"); writeFileSync(manifest.databaseFile, "replacement-is-not-image"); f.append();
          if (stale) f.control.stop({ identity: f.identity, expectedGeneration: 1n, target: "read-only-recovery", reasonCode: "integrity-failure" });
        } } });
      if (stale) { assert.equal(reply.kind, "failure"); if (reply.kind === "failure") assert.equal(reply.failure.code, "FRESH_START_CONTENT_UNVERIFIED"); assert.equal("content" in reply, false); }
      else {
        assert.equal(reply.kind, "success"); if (reply.kind !== "success" || reply.content?.operation !== "build-context-pack") assert.fail("context result required");
        assert.equal(reply.receipt.scope.sessionId, null); assert.equal(reply.content.selectionScope.sessionId, NATIVE_SESSION);
        assert.equal(reply.receipt.imageSha256, sha); assert.equal(reply.receipt.projectionEventPosition, manifest.terminalEventPosition);
        assert.ok(reply.content.items.some(item => item.id === corpus.ids.canonical)); assert.ok(reply.content.followUps.length > 0);
        for (const item of [...reply.content.items, ...reply.content.followUps]) assert.ok(BigInt(item.sourceEventPosition) <= BigInt(manifest.terminalEventPosition));
        assert.deepEqual(phases, ["admission", "projection-wait", "capture", "validate", "query", "revalidate"]);
      }
      assert.equal(existsSync(".projection-manifest.publish.lock"), false);
    } finally { process.chdir(cwd); f.cleanup(); }
  }
});

test("compiled_workflows_empty_populated_and_restarted", { timeout: 45000 }, async () => {
  const f = await deployMeasuredNativeFixture({ session: { sessionId: NATIVE_SESSION, minimumEventPosition: "0" } });
  let adapter = createVerifiedReadAdapter(f.binding), closed = false;
  const operations = ["list-canonical-records", "recent-canonical-records", "follow-up-radar", "build-context-pack"] as const;
  try {
    for (const operation of operations) {
      const result = await adapter.query(workflowRequest(operation)); assert.equal(result.receipt.projectionEventPosition, "0");
      assert.equal(result.content.operation, operation); assert.deepEqual(result.content.items, []);
      if (result.content.operation === "build-context-pack") assert.deepEqual(result.content.followUps, []);
    }
    const corpus = await f.appendCorpus(); const manifest = await f.publish();
    const sha = createHash("sha256").update(readFileSync(join(f.binding.projectionDirectory.canonicalPath, manifest.databaseFile))).digest("hex");
    for (const restarted of [false, true]) {
      if (restarted) { assert.equal((await adapter.close()).cleanup, "complete"); adapter = createVerifiedReadAdapter({ ...f.binding, compositionEpoch: "workflow-restarted" }); }
      for (const operation of operations) {
        const result = await adapter.query(workflowRequest(operation)); assert.equal(result.content.operation, operation);
        assert.equal(result.receipt.imageSha256, sha); assert.equal(result.receipt.projectionEventPosition, manifest.terminalEventPosition);
        assert.equal(result.receipt.scope.sessionId, null); assert.equal(result.content.selectionScope.sessionId, NATIVE_SESSION);
        if (result.content.operation === "build-context-pack") assert.ok(result.content.followUps.some(item => item.id === corpus.ids.openFollowUp));
        else assert.ok(result.content.items.length > 0);
      }
    }
    closed = (await adapter.close()).cleanup === "complete"; assert.equal(closed, true);
    assert.equal(await new VerifiedReadOwnershipRepository(f.binding.executorStateDirectory).inspect(), null);
    console.log(`compiled workflows build=${f.measuredBuildHash} image=${sha} position=${manifest.terminalEventPosition} empty/populated/restarted=true`);
  } finally { const diagnostic = await adapter.close(); if (closed || diagnostic.cleanup === "complete") f.cleanup(); else console.error(`Retained workflow root: ${f.root}`); }
});

import { fork, type ForkOptions } from "node:child_process";
import { fileURLToPath } from "node:url";
for (const phase of ["query", "packing"] as const) for (const aborted of [false, true]) for (const uncertainCleanup of [false, true]) test(`compiled_workflow_query_and_packing_deadline ${phase} abort=${aborted} uncertain=${uncertainCleanup}`, { timeout: 20000 }, async t => {
    const f = await makeNativeContentFixture(); const children: ReturnType<typeof fork>[] = []; const drained = new Set<ReturnType<typeof fork>>();
    const exits: { kind: string; code: number | null; signal: string | null }[] = [];
    let active = 0, maximumActiveReadOrCleanup = 0, blocked = false, closed = false;
    const executable = fileURLToPath(new URL("./fixtures/v2-verified-read-process-fixture.js", import.meta.url));
    const spawnOwned = (kind: string) => {
      const child = fork(executable, [kind], { cwd: f.binding.projectionDirectory.canonicalPath, execArgv: [], windowsHide: true,
        env: process.platform === "win32" ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR } : {}, stdio: ["ignore", "pipe", "pipe", "ipc"] } as ForkOptions);
      children.push(child); child.once("close", () => drained.add(child)); if (kind !== "writer") maximumActiveReadOrCleanup = Math.max(maximumActiveReadOrCleanup, ++active);
      child.once("exit", (code, signal) => { exits.push({ kind, code, signal }); if (kind !== "writer") active--; }); return child;
    };
    const until = async (predicate: () => boolean, ms = 3000) => { const deadline = performance.now() + ms;
      while (!predicate()) { assert.ok(performance.now() < deadline, "owned process barrier not reached"); await new Promise(r => setTimeout(r, 10)); } };
    const writer = spawnOwned("writer"); let adapter: ReturnType<typeof createVerifiedReadAdapter> | undefined;
    try {
      if (phase === "packing") {
        const itemId = "abcdefab-cdef-4abc-8abc-abcdefabcdef", seed = command();
        f.appendSynthetic({ ...seed, correlationId: itemId, streamType: "memory", events: [{ ...seed.events[0]!, eventType: "MemorySourceRecorded", eventSchemaVersion: 2,
          payload: { sourceVersion: 2, binding: { ...f.binding.projectionBinding, sessionId: null }, itemId,
            normalizedKey: "no-ranked-match", status: "verified", confidence: "high", verificationMethod: "committed-event",
            validFrom: FRESH_NOW, validTo: null, summary: "no-ranked-match packing candidate", contentHash: READ_HASH,
            conflictGroupId: null, supersedingItemId: null } }] });
        await f.publish(); const image = f.captureImage();
        try {
          const row = image.database.prepare("SELECT item_id, normalized_key, summary, status FROM canonical_items WHERE item_id = $id").get({ $id: itemId });
          assert.deepEqual({ ...row }, { item_id: itemId, normalized_key: "no-ranked-match", summary: "no-ranked-match packing candidate", status: "verified" });
          const request = workflowRequest("build-context-pack");
          const candidate = queryNativeContent(image.database, image.manifest, { request, binding: f.binding, remainingMs: 5000,
            receipt: nativeWorkflowReceipt(f, request, image.manifest) });
          assert.equal(candidate.operation, "build-context-pack");
          if (candidate.operation !== "build-context-pack") assert.fail("expected actual packing workflow query");
          assert.deepEqual(candidate.ranked.rankedCandidates.map(value => value.item?.id), [itemId]);
        } finally { image.close(); }
      } await until(() => existsSync(join(f.binding.projectionDirectory.canonicalPath, "writer-ready")));
      const writerBytes = readFileSync(join(f.binding.projectionDirectory.canonicalPath, "independent-writer.sqlite"));
      const ownership = new VerifiedReadOwnershipRepository(f.binding.executorStateDirectory);
      adapter = createVerifiedReadAdapter(f.binding, { ownership,
        now: () => performance.now(), schedule: (cb, ms) => setTimeout(cb, ms), clear: timer => clearTimeout(timer as NodeJS.Timeout),
        currentEpoch: () => f.binding.compositionEpoch, spawnOwned(kind) {
          const child = spawnOwned(kind === "read" ? `workflow-${phase}-hang` : "cleanup"); const errors = new Set<(error: unknown) => void>();
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
      const abort = new AbortController(); let parentTicks = 0; const timer = setInterval(() => parentTicks++, 10); const arrival = performance.now();
      try {
        let contentReleased = false; const outcomePromise = adapter.query({ ...workflowRequest(phase === "query" ? "list-canonical-records" : "build-context-pack"), budgetMs: 2000 }, { signal: abort.signal }).then(result => { contentReleased = true; return result; }, error => error);
        await until(() => existsSync(join(f.binding.projectionDirectory.canonicalPath, `workflow-${phase}-blocked`)), 1800); blocked = true;
        const originalOwnedToken = readFileSync(join(f.binding.projectionDirectory.canonicalPath, ".projection-manifest.publish.lock"), "utf8");
        assert.equal(readFileSync(join(f.binding.projectionDirectory.canonicalPath, `workflow-${phase}-blocked`), "utf8"), phase === "query" ? "validated-image-owned-lock-fixed-workflow-list-query" : "validated-image-owned-lock-prospective-workflow-envelope-packing");
        if (aborted) abort.abort(); const outcome = await outcomePromise; assert.equal(outcome.code, aborted ? "WORKER_CLOSED" : "WORKER_TIMEOUT"); assert.equal(contentReleased, false); assert.ok(parentTicks >= 5); assert.ok(performance.now() - arrival <= 3000);
        const diagnostic = await adapter.close(); closed = diagnostic.cleanup === "complete";
        assert.equal(diagnostic.code, aborted ? "WORKER_CLOSED" : "WORKER_TIMEOUT"); assert.equal(diagnostic.cleanup, uncertainCleanup ? "incomplete" : "complete");
        assert.equal(maximumActiveReadOrCleanup, 1); assert.equal(exits.filter(value => value.kind === `workflow-${phase}-hang`).length, 1);
        assert.notEqual(exits.find(value => value.kind === `workflow-${phase}-hang`)?.code, 0);
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
        const cleanupPositive = !uncertainCleanup; const ownerAbsent = await ownership.inspect() === null; assert.equal(ownerAbsent, cleanupPositive);
        if (uncertainCleanup) {
          assert.equal(readFileSync(join(f.binding.projectionDirectory.canonicalPath, ".projection-manifest.publish.lock"), "utf8"), originalOwnedToken);
          assert.equal((await ownership.inspect())?.lockToken, originalOwnedToken);
        }
        assert.ok(exits.findIndex(value => value.kind === `workflow-${phase}-hang`) < exits.findIndex(value => value.kind === "cleanup"));
      } finally { clearInterval(timer); }
      writer.send("stop"); await until(() => exits.some(value => value.kind === "writer"));
      assert.deepEqual(exits.find(value => value.kind === "writer"), { kind: "writer", code: 0, signal: null });
      console.log(`compiled workflow phase=${phase} aborted=${aborted} uncertain=${uncertainCleanup} parentTicks=${parentTicks} exits=${JSON.stringify(exits)} maximumActiveReadOrCleanup=${maximumActiveReadOrCleanup} ownershipAbsent=${closed} writerSurvived=true`);
    } finally {
      await adapter?.close();
      for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await until(() => children.every(child => drained.has(child)));
      if (closed || !adapter && !blocked) f.cleanup(); else { f.reader.close(); f.writer.close(); t.diagnostic(`Uncertain blocked-query root retained with original lock and ownership: ${f.root}`); }
    }
});


test("workflow_stale_cursor_preserves_primary_under_lock_cleanup_uncertainty", async t => {
  for (const uncertain of [false, true]) {
    const f = await makeNativeContentFixture(); const cwd = process.cwd(); let closed = false;
    try {
      await f.appendCorpus(); await f.publish(); process.chdir(f.binding.projectionDirectory.canonicalPath);
      const dependencies = { inspectBuild: () => f.measuredBuildHash, now: () => 0, wait: async () => {}, signal: new AbortController().signal, emitStage: (_stage: unknown) => {} };
      const bootstrap = decodeReadBootstrap({ version: 3, ids: readBootstrap().ids, binding: f.binding,
        request: { ...workflowRequest("list-canonical-records"), parameters: { limit: 1 } }, lockToken: "b".repeat(32), remainingMs: 5000 });
      const first = await executeVerifiedRead(bootstrap, dependencies);
      if (first.kind !== "success" || first.content?.operation !== "list-canonical-records") assert.fail("list cursor required");
      assert.ok(first.content.nextCursor); process.chdir(cwd); await f.publish(); process.chdir(f.binding.projectionDirectory.canonicalPath);
      const reply = await executeVerifiedRead({ ...bootstrap, request: { ...workflowRequest("list-canonical-records"), operation: "list-canonical-records", parameters: { cursor: first.content.nextCursor! } } }, {
        ...dependencies, emitStage(stage) { if (uncertain && stage.phase === "query") writeFileSync(".projection-manifest.publish.lock", "c".repeat(32)); } });
      assert.equal(reply.kind, "failure"); if (reply.kind !== "failure") assert.fail("stale must refuse");
      assert.equal(reply.failure.code, "V2_CONTENT_CURSOR_STALE"); assert.equal(reply.failure.cleanup, uncertain ? "incomplete" : "complete");
      assert.equal("content" in reply, false); closed = !uncertain;
      if (uncertain) assert.equal(readFileSync(".projection-manifest.publish.lock", "utf8"), "c".repeat(32));
    } finally { process.chdir(cwd); if (closed || !existsSync(join(f.binding.projectionDirectory.canonicalPath, ".projection-manifest.publish.lock"))) f.cleanup(); else { f.reader.close(); f.writer.close(); t.diagnostic(`Retained stale cursor uncertainty root: ${f.root}`); } }
  }
});
