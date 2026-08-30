import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";
import { once } from "node:events";
import {
  LIFECYCLE_FIXTURE_BARRIER_NAMES,
  LifecycleFixtureClient,
  assertLifecycleFixtureJson,
  type LifecycleFixtureBarrierName,
  type LifecycleFixtureErrorMessage,
  type LifecycleFixtureResultMessage,
} from "./support/lifecycle-fixture-client.js";
import {
  LifecycleTestKeyBroker,
  type LifecycleTestKeyBrokerFingerprintMatcher,
} from "./support/lifecycle-test-key-broker.js";

const FIXTURE_PATH = fileURLToPath(new URL("./fixtures/project-store-lifecycle-child.js", import.meta.url));
const KEY_PROBE_FIXTURE_PATH = fileURLToPath(new URL("./fixtures/lifecycle-key-protocol-child.js", import.meta.url));
const SCOPE = Object.freeze({
  projectId: "00000000-0000-4000-8000-000000000101",
  storeId: "00000000-0000-4000-8000-000000000103",
});
const PURPOSE = "child-session-handle" as const;
const BARRIER_NAMES: readonly LifecycleFixtureBarrierName[] = [
  "ready",
  "start",
  "binding",
  "open",
  "started",
  "mutation",
  "bounded",
  "query",
  "validation",
  "fault",
  "key-request",
  "key-response",
  "barrier-arm",
  "barrier-reached",
  "barrier-release",
  "result",
  "error",
  "close",
];

function writeControlledFixture(root: string, source: string): string {
  const fixturePath = join(root, "controlled-lifecycle-fixture.cjs");
  writeFileSync(fixturePath, source, "utf8");
  return fixturePath;
}

describe("Task 18 lifecycle fixture infrastructure", () => {
  let client: LifecycleFixtureClient | undefined;
  const roots: string[] = [];

  afterEach(async () => {
    try {
      await client?.dispose();
    } finally {
      client = undefined;
      for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    }
  });

  it("exposes the complete named barrier vocabulary and accepts JSON-only payloads", () => {
    assert.deepEqual(LIFECYCLE_FIXTURE_BARRIER_NAMES, BARRIER_NAMES);
    assertLifecycleFixtureJson({
      requestId: "request-1",
      nested: [null, true, 3, "safe"],
    });
    assert.throws(
      () => assertLifecycleFixtureJson(Buffer.from("key-material")),
      /JSON/i,
    );
    assert.throws(
      () => assertLifecycleFixtureJson({ value: undefined }),
      /JSON/i,
    );
  });

  it("rejects a Git probe diagnostic attached to a non-Git fixture error", async () => {
    const root = mkdtempSync(join(tmpdir(), "task18-fixture-invalid-git-diagnostic-"));
    roots.push(root);
    const controlledFixturePath = writeControlledFixture(root, `
      process.send?.({ type: "ready", childId: "invalid-git-diagnostic", pid: process.pid });
      process.on("message", (message) => {
        process.send?.({
          type: "error",
          requestId: message.requestId,
          code: "FIXTURE_PROTOCOL_ERROR",
          message: "FIXTURE_PROTOCOL_ERROR",
          gitProbeDiagnostic: {
            phase: "binding",
            reason: "COMMAND_FAILED",
            probes: [{
              argv: ["rev-parse", "--show-toplevel"],
              cwd: "C:\\\\fixture-probe",
              status: null,
              stdout: "",
              stderr: "",
              spawnError: null
            }]
          }
        });
      });
    `);
    client = new LifecycleFixtureClient({
      fixturePath: controlledFixturePath,
      timeoutMs: 5_000,
      cleanupTimeoutMs: 5_000,
    });

    await client.ready();
    try {
      await assert.rejects(client.binding(), /invalid child fixture message/i);
    } finally {
      await client.forceCleanup();
    }
  });

  it("uses a JSON fork transport and closes a fixture cooperatively", async () => {
    client = new LifecycleFixtureClient({
      fixturePath: FIXTURE_PATH,
      timeoutMs: 5_000,
      cleanupTimeoutMs: 5_000,
    });

    const ready = await client.ready();
    assert.equal(ready.type, "ready");
    assert.equal(client.transport.serialization, "json");
    assert.equal(client.transport.shell, false);
    assert.equal(client.transport.workerData, undefined);
    assert.equal(client.child.connected, true);

    const closed = await client.close();
    assert.equal(closed.type, "close");
    assert.equal(client.exit?.code, 0);
    assert.equal(client.exit?.signal, null);
    assert.equal(client.child.connected, false);
  });

  it("scans registered stderr canaries without retaining stderr content", async () => {
    const canary = "TASK18_STDERR_PROBE_CANARY";
    const root = mkdtempSync(join(tmpdir(), "task18-stderr-probe-"));
    roots.push(root);
    const controlledFixturePath = writeControlledFixture(root, `
      const childId = "stderr-probe-child";
      process.stderr.write("TASK18_STDERR_");
      process.stderr.write("PROBE_CANARY", () => {
        process.send?.({ type: "ready", childId, pid: process.pid });
      });
      process.on("message", (message) => {
        if (message?.type === "close") {
          process.send?.({ type: "close", requestId: message.requestId, childId });
          process.disconnect?.();
        }
      });
    `);
    client = new LifecycleFixtureClient({
      fixturePath: controlledFixturePath,
      timeoutMs: 5_000,
      cleanupTimeoutMs: 5_000,
      stderrCanaries: [canary],
    });

    await client.ready();
    await client.waitForStderrCanary(canary);
    assert.equal(client.stderrCanaryDetected(canary), true);
    assert.ok(client.stderr.every((line) => !line.includes(canary)));
    await client.close();
  });

  it("acknowledges each immediate close request before cooperative disconnect", async () => {
    client = new LifecycleFixtureClient({
      fixturePath: FIXTURE_PATH,
      timeoutMs: 5_000,
      cleanupTimeoutMs: 5_000,
    });
    await client.ready();

    const firstRequestId = "close-request-one";
    const secondRequestId = "close-request-two";
    const first = client.waitFor("close", "first close acknowledgement");
    const second = client.waitFor("close", "second close acknowledgement");
    client.send({ type: "close", requestId: firstRequestId });
    client.send({ type: "close", requestId: secondRequestId });

    const acknowledgements = await Promise.all([first, second]);
    assert.deepEqual(
      new Set(acknowledgements.map((acknowledgement) => acknowledgement.requestId)),
      new Set([firstRequestId, secondRequestId]),
    );
    assert.ok(acknowledgements.every((acknowledgement) => acknowledgement.childId.length > 0));

    const closed = await client.close();
    assert.ok(closed.requestId.length > 0);
    assert.equal(client.exit?.code, 0);
  });

  it("correlates an injected close-resource failure before bounded cleanup", async () => {
    client = new LifecycleFixtureClient({
      fixturePath: FIXTURE_PATH,
      env: { LIFECYCLE_FIXTURE_TEST_CLOSE_FAILURE: "1" },
      timeoutMs: 5_000,
      cleanupTimeoutMs: 5_000,
    });
    await client.ready();

    await assert.rejects(client.close(), /fixture close failed: FIXTURE_CLOSE_FAILURE/i);
    assert.equal(client.disconnected, true);
    assert.equal(client.exit?.code, 0);
    assert.equal(client.exit?.signal, null);
  });

  it("escalates bounded forced cleanup for a child that ignores cooperative close and disconnect", async () => {
    const root = mkdtempSync(join(tmpdir(), "task18-fixture-stuck-cleanup-"));
    roots.push(root);
    const controlledFixturePath = writeControlledFixture(root, `
      const childId = "stuck-cleanup-child";
      process.on("message", () => {});
      setInterval(() => {}, 1_000);
      process.send?.({ type: "ready", childId, pid: process.pid });
    `);
    client = new LifecycleFixtureClient({
      fixturePath: controlledFixturePath,
      timeoutMs: 5_000,
      cleanupTimeoutMs: 50,
    });
    await client.ready();

    try {
      const exit = await client.forceCleanup();
      assert.equal(exit?.code, null);
      assert.ok(exit?.signal === "SIGTERM" || exit?.signal === "SIGKILL");
      assert.deepEqual(client.exit, exit);
      assert.equal(client.child.killed, true);
      assert.throws(() => process.kill(client!.child.pid!, 0), /ESRCH|no such process/i);
    } finally {
      if (client.exit === undefined) {
        const exited = once(client.child, "exit");
        client.child.kill("SIGKILL");
        await exited;
      }
    }
  });

  it("rejects start before explicit binding and open", async () => {
    client = new LifecycleFixtureClient({
      fixturePath: FIXTURE_PATH,
      timeoutMs: 5_000,
      cleanupTimeoutMs: 5_000,
    });

    await client.ready();
    const response = await client.start();
    assert.equal(response.type, "error");
    assert.equal(response.code, "FIXTURE_PROTOCOL_ERROR");
    assert.ok(response.requestId.length > 0);
  });

  it("drives a project start through explicit binding and open", async () => {
    const root = mkdtempSync(join(tmpdir(), "task18-fixture-client-start-"));
    roots.push(root);
    const projectRoot = join(root, "project");
    const vaultRoot = join(projectRoot, "memory");
    mkdirSync(vaultRoot, { recursive: true });
    client = new LifecycleFixtureClient({
      fixturePath: FIXTURE_PATH,
      timeoutMs: 5_000,
      cleanupTimeoutMs: 5_000,
    });

    const started = await client.start({
      projectRoot,
      vaultRoot,
      clientInstanceId: "task18-fixture-client-start",
    });
    assert.equal(started.type, "started");
    assert.ok((started.payload as Record<string, unknown>).projectId !== undefined);
  });

  it("returns bounded real Git probe diagnostics when the fixture cannot spawn git", async () => {
    const root = mkdtempSync(join(tmpdir(), "task18-fixture-git-probe-"));
    roots.push(root);
    const projectRoot = join(root, "project");
    const vaultRoot = join(projectRoot, "memory");
    const gitlessPath = join(root, "gitless-path");
    mkdirSync(vaultRoot, { recursive: true });
    mkdirSync(gitlessPath);
    client = new LifecycleFixtureClient({
      fixturePath: FIXTURE_PATH,
      env: { ...process.env, PATH: gitlessPath },
      timeoutMs: 5_000,
      cleanupTimeoutMs: 5_000,
    });

    await client.ready();
    const failure = await client.binding({
      projectRoot,
      vaultRoot,
      clientInstanceId: "task18-fixture-git-probe",
    });
    assert.equal(failure.type, "error");
    assert.equal(failure.code, "GIT_PROBE_FAILED");
    const diagnostic = (failure as typeof failure & {
      readonly gitProbeDiagnostic?: {
        readonly phase: unknown;
        readonly reason: unknown;
        readonly probes: readonly {
          readonly argv: unknown;
          readonly cwd: unknown;
          readonly status: unknown;
          readonly stdout: unknown;
          readonly stderr: unknown;
          readonly spawnError: unknown;
        }[];
      };
    }).gitProbeDiagnostic;
    assert.equal(diagnostic?.phase, "bootstrap");
    assert.equal(diagnostic?.reason, "COMMAND_FAILED");
    assert.equal(diagnostic?.probes.length, 1);
    assert.deepEqual(diagnostic?.probes[0]?.argv, ["rev-parse", "--show-toplevel"]);
    assert.equal(diagnostic?.probes[0]?.cwd, projectRoot);
    assert.equal(diagnostic?.probes[0]?.status, null);
    assert.equal(diagnostic?.probes[0]?.stdout, "");
    assert.equal(diagnostic?.probes[0]?.stderr, "");
    assert.equal((diagnostic?.probes[0]?.spawnError as { readonly code?: unknown } | null)?.code, "ENOENT");
    assert.ok(typeof (diagnostic?.probes[0]?.spawnError as { readonly message?: unknown } | null)?.message === "string");
  });

  it("acknowledges explicit project binding and open before it reports started", async () => {
    const root = mkdtempSync(join(tmpdir(), "task18-fixture-protocol-"));
    roots.push(root);
    const projectRoot = join(root, "project");
    const vaultRoot = join(projectRoot, "memory");
    mkdirSync(vaultRoot, { recursive: true });
    client = new LifecycleFixtureClient({
      fixturePath: FIXTURE_PATH,
      timeoutMs: 5_000,
      cleanupTimeoutMs: 5_000,
    });

    assert.equal((await client.ready()).type, "ready");
    const binding = await client.binding({
      projectRoot,
      vaultRoot,
      clientInstanceId: "task18-fixture-protocol",
    });
    assert.equal(binding.type, "result");
    assert.equal(binding.operation, "binding");
    assert.deepEqual(binding.value, { phase: "bound" });

    const opened = await client.open();
    assert.equal(opened.type, "result");
    assert.equal(opened.operation, "open");
    assert.deepEqual(opened.value, { phase: "open" });

    const started = await client.start();
    assert.equal(started.type, "started");
    assert.equal((started.payload as Record<string, unknown>).projectId !== undefined, true);
  });

  it("holds a named lifecycle barrier until the parent releases it", async () => {
    const root = mkdtempSync(join(tmpdir(), "task18-fixture-barrier-"));
    roots.push(root);
    const projectRoot = join(root, "project");
    const vaultRoot = join(projectRoot, "memory");
    mkdirSync(vaultRoot, { recursive: true });
    client = new LifecycleFixtureClient({
      fixturePath: FIXTURE_PATH,
      timeoutMs: 5_000,
      cleanupTimeoutMs: 5_000,
    });

    await client.ready();
    await client.binding({ projectRoot, vaultRoot, clientInstanceId: "task18-fixture-barrier" });
    await client.open();
    await client.start();

    const barrier = await client.holdBarrier("mutation");
    let settled = false;
    const mutation = client.mutation({
      operation: "workflow-recovery",
      workId: "task18-fixture-barrier-work",
      ownerId: "task18-fixture-barrier-owner",
      fencingToken: "1",
      dueBefore: "2026-08-17T00:00:00.000Z",
      limit: 1,
    }).finally(() => { settled = true; });

    const reached = await barrier.reached();
    assert.equal(reached.payload.name, "mutation");
    assert.equal(settled, false);

    await barrier.release();
    assert.equal((await mutation).type, "result");
  });

  it("correlates lifecycle commands with a strict success or error response", async () => {
    const root = mkdtempSync(join(tmpdir(), "task18-fixture-routes-"));
    roots.push(root);
    const projectRoot = join(root, "project");
    const vaultRoot = join(projectRoot, "memory");
    mkdirSync(vaultRoot, { recursive: true });
    client = new LifecycleFixtureClient({
      fixturePath: FIXTURE_PATH,
      timeoutMs: 5_000,
      cleanupTimeoutMs: 5_000,
    });

    await client.ready();
    await client.binding({ projectRoot, vaultRoot, clientInstanceId: "task18-fixture-routes" });
    await client.open();
    await client.start();

    const mutation = await client.mutation({
      operation: "workflow-recovery",
      workId: "task18-fixture-route-work",
      ownerId: "task18-fixture-route-owner",
      fencingToken: "1",
      dueBefore: "2026-08-17T00:00:00.000Z",
      limit: 1,
    });
    assert.equal(mutation.type, "result");
    assert.equal(mutation.operation, "mutation");
    assert.ok(mutation.requestId.length > 0);

    const unsupportedMutation = await client.mutation({ operation: "not-supported" });
    assert.equal(unsupportedMutation.type, "error");
    assert.equal(unsupportedMutation.code, "FIXTURE_PROTOCOL_ERROR");
    assert.ok(unsupportedMutation.requestId.length > 0);

    for (const response of await Promise.all([
      client.bounded({ limit: 1 }),
      client.query({ kind: "active" }),
      client.validation({ work: "protocol-probe" }),
      client.fault({ boundary: "not-a-boundary", point: "before-write" }),
    ])) {
      assert.equal(response.type, "error");
      assert.equal(response.code, "FIXTURE_PROTOCOL_ERROR");
      assert.ok(response.requestId.length > 0);
    }

    const fault = await client.fault({ boundary: "ownership-recovery", point: "before-write" });
    assert.equal(fault.type, "result");
    assert.equal(fault.operation, "fault");
    assert.ok(fault.requestId.length > 0);
  });

  it("returns an exact correlated error for an unsupported mutation", async () => {
    const root = mkdtempSync(join(tmpdir(), "task18-fixture-unsupported-mutation-"));
    roots.push(root);
    const projectRoot = join(root, "project");
    const vaultRoot = join(projectRoot, "memory");
    mkdirSync(vaultRoot, { recursive: true });
    client = new LifecycleFixtureClient({
      fixturePath: FIXTURE_PATH,
      timeoutMs: 5_000,
      cleanupTimeoutMs: 5_000,
    });
    assert.equal((await client.start({
      projectRoot,
      vaultRoot,
      clientInstanceId: "task18-fixture-unsupported-mutation",
    })).type, "started");

    const requestId = "unsupported-mutation-request";
    const response = client.waitFor(
      (message): message is LifecycleFixtureErrorMessage =>
        message.type === "error" && message.requestId === requestId,
      "unsupported mutation response",
    );
    client.send({
      type: "mutation",
      requestId,
      payload: { operation: "protocol-emit-uncorrelated-response" },
    });

    const error = await response;
    assert.equal(error.requestId, requestId);
    assert.equal(error.code, "FIXTURE_PROTOCOL_ERROR");
  });

  it("accepts only responses correlated to an issued request ID", async () => {
    const root = mkdtempSync(join(tmpdir(), "task18-fixture-correlation-"));
    roots.push(root);
    const controlledFixturePath = writeControlledFixture(root, `
      const childId = "controlled-correlation-child";
      process.send?.({ type: "ready", childId, pid: process.pid });
      process.on("message", (message) => {
        if (message?.type === "mutation") {
          process.send?.({
            type: "result",
            requestId: "controlled-unknown-request-id",
            operation: "mutation",
            value: { probe: "uncorrelated-response" },
          });
          return;
        }
        if (message?.type === "close") {
          process.send?.({ type: "close", requestId: message.requestId, childId });
        }
      });
    `);
    client = new LifecycleFixtureClient({
      fixturePath: controlledFixturePath,
      timeoutMs: 5_000,
      cleanupTimeoutMs: 5_000,
    });
    await client.ready();

    const issuedRequestId = "issued-mutation-request";
    const mismatchedResponse = client.waitFor(
      (message): message is LifecycleFixtureResultMessage | LifecycleFixtureErrorMessage =>
        (message.type === "result" || message.type === "error") && message.requestId === issuedRequestId,
      "issued mutation response",
    );
    client.send({
      type: "mutation",
      requestId: issuedRequestId,
      payload: { operation: "controlled-uncorrelated-response" },
    });
    await assert.rejects(mismatchedResponse, /uncorrelated child fixture message/i);
  });

  it("clears every pending request after a terminal uncorrelated response", async () => {
    const root = mkdtempSync(join(tmpdir(), "task18-fixture-terminal-pending-"));
    roots.push(root);
    const controlledFixturePath = writeControlledFixture(root, `
      const childId = "controlled-terminal-pending-child";
      let firstMutationRequestId;
      process.send?.({ type: "ready", childId, pid: process.pid });
      process.on("message", (message) => {
        if (message?.type === "mutation") {
          firstMutationRequestId ??= message.requestId;
          return;
        }
        if (message?.type === "fault") {
          process.send?.({
            type: "result",
            requestId: "controlled-terminal-unknown-request",
            operation: "fault",
            value: { probe: "terminal-uncorrelated" },
          });
          return;
        }
        if (message?.type === "query") {
          process.send?.({
            type: "result",
            requestId: firstMutationRequestId,
            operation: "mutation",
            value: { probe: "late-old-mutation" },
          });
          process.send?.({
            type: "result",
            requestId: message.requestId,
            operation: "query",
            value: { probe: "nominal-query" },
          });
          return;
        }
        if (message?.type === "close") {
          process.send?.({ type: "close", requestId: message.requestId, childId });
        }
      });
    `);
    client = new LifecycleFixtureClient({
      fixturePath: controlledFixturePath,
      timeoutMs: 5_000,
      cleanupTimeoutMs: 5_000,
    });
    await client.ready();

    const firstId = "terminal-pending-first";
    const secondId = "terminal-pending-second";
    const firstFailure = assert.rejects(
      client.waitFor(
        (message): message is LifecycleFixtureResultMessage | LifecycleFixtureErrorMessage =>
          (message.type === "result" || message.type === "error") && message.requestId === firstId,
        "first terminal pending response",
      ),
      /uncorrelated child fixture message/i,
    );
    const secondFailure = assert.rejects(
      client.waitFor(
        (message): message is LifecycleFixtureResultMessage | LifecycleFixtureErrorMessage =>
          (message.type === "result" || message.type === "error") && message.requestId === secondId,
        "second terminal pending response",
      ),
      /uncorrelated child fixture message/i,
    );
    client.send({ type: "mutation", requestId: firstId, payload: { operation: "first" } });
    client.send({ type: "mutation", requestId: secondId, payload: { operation: "second" } });
    client.send({ type: "fault", requestId: "terminal-pending-trigger", payload: {} });
    await Promise.all([firstFailure, secondFailure]);

    try {
      await assert.rejects(client.query({ kind: "after-terminal" }), /uncorrelated child fixture message/i);
    } finally {
      await client.forceCleanup();
    }
  });

  it("retires a timed-out request before a controlled late response", async () => {
    const root = mkdtempSync(join(tmpdir(), "task18-fixture-timeout-pending-"));
    roots.push(root);
    const controlledFixturePath = writeControlledFixture(root, `
      const childId = "controlled-timeout-pending-child";
      let timedOutMutationRequestId;
      process.send?.({ type: "ready", childId, pid: process.pid });
      process.on("message", (message) => {
        if (message?.type === "mutation") {
          timedOutMutationRequestId = message.requestId;
          return;
        }
        if (message?.type === "query") {
          process.send?.({
            type: "result",
            requestId: timedOutMutationRequestId,
            operation: "mutation",
            value: { probe: "late-timed-out-mutation" },
          });
          process.send?.({
            type: "result",
            requestId: message.requestId,
            operation: "query",
            value: { probe: "nominal-query" },
          });
          return;
        }
        if (message?.type === "close") {
          process.send?.({ type: "close", requestId: message.requestId, childId });
        }
      });
    `);
    client = new LifecycleFixtureClient({
      fixturePath: controlledFixturePath,
      timeoutMs: 500,
      cleanupTimeoutMs: 5_000,
    });
    await client.ready();

    await assert.rejects(
      client.mutation({ operation: "controlled-timeout" }),
      /mutation:.*barrier timed out/i,
    );
    try {
      await assert.rejects(client.query({ kind: "after-timeout" }), /uncorrelated child fixture message/i);
    } finally {
      await client.forceCleanup();
    }
  });

  it("clears a manually awaited request when its waiter times out", async () => {
    const root = mkdtempSync(join(tmpdir(), "task18-fixture-manual-timeout-"));
    roots.push(root);
    const controlledFixturePath = writeControlledFixture(root, `
      const childId = "controlled-manual-timeout-child";
      let timedOutMutationRequestId;
      process.send?.({ type: "ready", childId, pid: process.pid });
      process.on("message", (message) => {
        if (message?.type === "mutation") {
          timedOutMutationRequestId = message.requestId;
          return;
        }
        if (message?.type === "query") {
          process.send?.({
            type: "result",
            requestId: timedOutMutationRequestId,
            operation: "mutation",
            value: { probe: "late-manual-mutation" },
          });
          process.send?.({
            type: "result",
            requestId: message.requestId,
            operation: "query",
            value: { probe: "nominal-query" },
          });
          return;
        }
        if (message?.type === "close") {
          process.send?.({ type: "close", requestId: message.requestId, childId });
        }
      });
    `);
    client = new LifecycleFixtureClient({
      fixturePath: controlledFixturePath,
      timeoutMs: 500,
      cleanupTimeoutMs: 5_000,
    });
    await client.ready();

    const requestId = "manual-timeout-request";
    const timedOut = client.waitFor(
      (message): message is LifecycleFixtureResultMessage | LifecycleFixtureErrorMessage =>
        (message.type === "result" || message.type === "error") && message.requestId === requestId,
      "manual timeout response",
    );
    client.send({ type: "mutation", requestId, payload: { operation: "manual-timeout" } });
    await assert.rejects(timedOut, /manual timeout response barrier timed out/i);

    try {
      await assert.rejects(client.query({ kind: "after-manual-timeout" }), /uncorrelated child fixture message/i);
    } finally {
      await client.forceCleanup();
    }
  });

  it("rejects a same-request-ID result with the wrong operation immediately", async () => {
    const root = mkdtempSync(join(tmpdir(), "task18-fixture-wrong-operation-"));
    roots.push(root);
    const controlledFixturePath = writeControlledFixture(root, `
      const childId = "controlled-wrong-operation-child";
      process.send?.({ type: "ready", childId, pid: process.pid });
      process.on("message", (message) => {
        if (message?.type === "mutation") {
          process.send?.({
            type: "result",
            requestId: message.requestId,
            operation: "query",
            value: { probe: "wrong-operation" },
          });
          process.send?.({
            type: "result",
            requestId: message.requestId,
            operation: "mutation",
            value: { probe: "late-nominal-operation" },
          });
          return;
        }
        if (message?.type === "close") {
          process.send?.({ type: "close", requestId: message.requestId, childId });
        }
      });
    `);
    client = new LifecycleFixtureClient({
      fixturePath: controlledFixturePath,
      timeoutMs: 5_000,
      cleanupTimeoutMs: 5_000,
    });
    await client.ready();

    try {
      await assert.rejects(
        client.mutation({ operation: "controlled-wrong-operation" }),
        /unexpected result operation/i,
      );
    } finally {
      await client.forceCleanup();
    }
  });

  it("tombstones a wrong-operation ID before a late nominal response", async () => {
    const root = mkdtempSync(join(tmpdir(), "task18-fixture-tombstoned-request-"));
    roots.push(root);
    const controlledFixturePath = writeControlledFixture(root, `
      const childId = "controlled-tombstoned-request-child";
      let failedRequestId;
      process.send?.({ type: "ready", childId, pid: process.pid });
      process.on("message", (message) => {
        if (message?.type === "mutation") {
          failedRequestId ??= message.requestId;
          process.send?.({
            type: "result",
            requestId: message.requestId,
            operation: "query",
            value: { probe: "wrong-operation" },
          });
          return;
        }
        if (message?.type === "query") {
          process.send?.({
            type: "result",
            requestId: failedRequestId,
            operation: "mutation",
            value: { probe: "late-nominal-response" },
          });
          process.send?.({
            type: "result",
            requestId: message.requestId,
            operation: "query",
            value: { probe: "nominal-query" },
          });
          return;
        }
        if (message?.type === "close") {
          process.send?.({ type: "close", requestId: message.requestId, childId });
        }
      });
    `);
    client = new LifecycleFixtureClient({
      fixturePath: controlledFixturePath,
      timeoutMs: 5_000,
      cleanupTimeoutMs: 5_000,
    });
    await client.ready();

    const failedRequestId = "tombstoned-wrong-operation";
    const failedResponse = client.waitFor(
      (message): message is LifecycleFixtureResultMessage | LifecycleFixtureErrorMessage =>
        (message.type === "result" || message.type === "error") && message.requestId === failedRequestId,
      "tombstoned wrong-operation response",
    );
    client.send({
      type: "mutation",
      requestId: failedRequestId,
      payload: { operation: "controlled-wrong-operation" },
    });
    await assert.rejects(failedResponse, /unexpected result operation/i);

    assert.throws(
      () => client!.send({
        type: "mutation",
        requestId: failedRequestId,
        payload: { operation: "must-not-reuse" },
      }),
      /request ID is retired/i,
    );
    try {
      await assert.rejects(client.query({ kind: "after-tombstone" }), /uncorrelated child fixture message/i);
    } finally {
      await client.forceCleanup();
    }
  });

  it("rejects a child-only protocol message before it can enter parent IPC", async () => {
    client = new LifecycleFixtureClient({
      fixturePath: FIXTURE_PATH,
      timeoutMs: 5_000,
      cleanupTimeoutMs: 5_000,
    });
    await client.ready();

    assert.throws(() => client!.send({
      type: "result",
      requestId: "must-not-be-sent-by-parent",
      value: { accepted: true },
    } as never), /parent fixture message/i);
  });

  it("consumes an unmatched key response without emitting a public child message", async () => {
    client = new LifecycleFixtureClient({
      fixturePath: FIXTURE_PATH,
      timeoutMs: 5_000,
      cleanupTimeoutMs: 5_000,
    });
    await client.ready();

    const firstStartId = "unmatched-key-first-start";
    const secondStartId = "unmatched-key-second-start";
    const first = client.waitFor(
      (message): message is LifecycleFixtureErrorMessage =>
        message.type === "error" && message.requestId === firstStartId,
      "first unmatched-key start response",
    );
    const second = client.waitFor(
      (message): message is LifecycleFixtureErrorMessage =>
        message.type === "error" && message.requestId === secondStartId,
      "second unmatched-key start response",
    );
    client.send({ type: "start", requestId: firstStartId });
    client.send({
      type: "key-response",
      requestId: "unmatched-key-response-id",
      payload: { ok: false, code: "FIXTURE_KEY_RESPONSE_UNMATCHED" },
    });
    client.send({ type: "start", requestId: secondStartId });

    try {
      const [firstError, secondError] = await Promise.all([first, second]);
      assert.equal(firstError.code, "FIXTURE_PROTOCOL_ERROR");
      assert.equal(secondError.code, "FIXTURE_PROTOCOL_ERROR");
    } finally {
      await client.forceCleanup();
    }
  });

  it("rejects argv or environment injection for a broker-backed fixture", () => {
    const broker = new LifecycleTestKeyBroker({ seed: "task18-broker-transport-policy" });
    try {
      assert.throws(() => new LifecycleFixtureClient({
        fixturePath: FIXTURE_PATH,
        keyBroker: broker,
        args: ["TASK18_ARGUMENT_CANARY"],
      }), /broker-backed fixture/i);
      assert.throws(() => new LifecycleFixtureClient({
        fixturePath: FIXTURE_PATH,
        keyBroker: broker,
        env: { TASK18_ENV_CANARY: "blocked" },
      }), /broker-backed fixture/i);
    } finally {
      broker.shutdown();
    }
  });

  it("keeps key operations in the parent broker, rotates deterministically, and zeroizes on shutdown", () => {
    const broker = new LifecycleTestKeyBroker({ seed: "task18-fixture-seed" });
    const plaintext = Buffer.from("fixture-secret", "utf8");
    const first = broker.currentKey(SCOPE, PURPOSE);
    const firstMac = broker.mac({
      ...SCOPE,
      purpose: PURPOSE,
      keyId: first.keyId,
      domain: "test/mac",
      bytes: plaintext,
    });
    assert.equal(broker.verify({
      ...SCOPE,
      purpose: PURPOSE,
      keyId: first.keyId,
      domain: "test/mac",
      bytes: plaintext,
      mac: firstMac,
    }), true);
    assert.equal(broker.fingerprint({
      ...SCOPE,
      purpose: PURPOSE,
      keyId: first.keyId,
      domain: "test/fingerprint",
      bytes: plaintext,
    }).length, 64);
    const sealed = broker.seal({
      ...SCOPE,
      purpose: PURPOSE,
      keyId: first.keyId,
      domain: "test/seal",
      bytes: plaintext,
    });
    assert.deepEqual(broker.open({
      ...SCOPE,
      purpose: PURPOSE,
      keyId: first.keyId,
      domain: "test/seal",
      sealed,
    }), plaintext);
    assert.throws(() => broker.open({
      ...SCOPE,
      purpose: PURPOSE,
      keyId: first.keyId,
      domain: "test/seal",
      sealed: { ...sealed, algorithm: "tampered" },
    }), /invalid|authentication/i);
    assert.throws(() => broker.open({
      ...SCOPE,
      purpose: PURPOSE,
      keyId: first.keyId,
      domain: "test/seal",
      sealed: { ...sealed, nonce: "dGFtcGVyZWQ" },
    }), /invalid|authentication|unsupported/i);

    const rotated = broker.rotate(SCOPE, PURPOSE);
    assert.equal(rotated.keyId, "fixture-child-session-handle-002");
    assert.equal(broker.status(SCOPE, PURPOSE, first.keyId), "available");
    broker.setHistoricalStatus(SCOPE, PURPOSE, first.keyId, "unavailable");
    assert.equal(broker.status(SCOPE, PURPOSE, first.keyId), "unavailable");
    assert.throws(() => broker.open({
      ...SCOPE,
      purpose: PURPOSE,
      keyId: first.keyId,
      domain: "test/seal",
      sealed,
    }), /unavailable/i);
    broker.setHistoricalStatus(SCOPE, PURPOSE, first.keyId, "revoked");
    assert.equal(broker.status(SCOPE, PURPOSE, first.keyId), "revoked");

    const matcher: LifecycleTestKeyBrokerFingerprintMatcher = {
      purpose: PURPOSE,
      keyId: rotated.keyId,
    };
    const removeFailure = broker.injectFingerprintFailure(matcher);
    assert.throws(() => broker.fingerprint({
      ...SCOPE,
      purpose: PURPOSE,
      keyId: rotated.keyId,
      domain: "test/fingerprint",
      bytes: plaintext,
    }), /fingerprint/i);
    removeFailure();
    assert.equal(broker.fingerprint({
      ...SCOPE,
      purpose: PURPOSE,
      keyId: rotated.keyId,
      domain: "test/fingerprint",
      bytes: plaintext,
    }).length, 64);

    assert.ok(broker.calls.every((call) => !("bytes" in call)));
    plaintext.fill(0);
    firstMac.fill(0);
    broker.shutdown();
    assert.equal(broker.keyMaterialZeroized, true);
    assert.equal(broker.liveKeyMaterialCount, 0);
  });

  it("binds key RPCs to the opened scope and rejects malformed or duplicate requests before broker reuse", async () => {
    const broker = new LifecycleTestKeyBroker({ seed: "task18-key-protocol-probe" });
    client = new LifecycleFixtureClient({
      fixturePath: KEY_PROBE_FIXTURE_PATH,
      timeoutMs: 5_000,
      cleanupTimeoutMs: 5_000,
      keyBroker: broker,
      keyScope: SCOPE,
    });
    try {
      await client.ready();
      assert.equal((await client.start(SCOPE)).type, "started");

      const wrongScope = await client.mutation({ operation: "wrong-scope" });
      assert.equal(wrongScope.type, "result");
      assert.deepEqual(wrongScope.value, { code: "FIXTURE_KEY_SCOPE_MISMATCH" });
      assert.equal(broker.calls.length, 0);

      const extraField = await client.mutation({ operation: "extra-field" });
      assert.equal(extraField.type, "result");
      assert.deepEqual(extraField.value, { code: "FIXTURE_KEY_BROKER_ERROR" });
      assert.equal(broker.calls.length, 0);

      const duplicate = await client.mutation({ operation: "duplicate" });
      assert.equal(duplicate.type, "result");
      assert.deepEqual(duplicate.value, {
        first: "ok",
        second: "FIXTURE_KEY_REQUEST_DUPLICATE",
      });
      assert.equal(broker.calls.length, 1);
      assert.equal(client.keyRequestAudit.length, 1);
      assert.ok(client.keyRequestAudit.every((request) => (
        !Object.prototype.hasOwnProperty.call(request, "bytes")
        && !Object.prototype.hasOwnProperty.call(request, "mac")
        && !Object.prototype.hasOwnProperty.call(request, "sealed")
      )));

      try {
        await assert.rejects(
          client.mutation({ operation: "forged-key-response" }),
          /invalid child fixture message/i,
        );
      } finally {
        await client.forceCleanup();
      }
      assert.equal(broker.calls.length, 1);
    } finally {
      broker.shutdown();
    }
  });

  it("does not let a child replace the parent-bound key scope through its started payload", async () => {
    const broker = new LifecycleTestKeyBroker({ seed: "task18-parent-key-scope" });
    client = new LifecycleFixtureClient({
      fixturePath: KEY_PROBE_FIXTURE_PATH,
      timeoutMs: 5_000,
      cleanupTimeoutMs: 5_000,
      keyBroker: broker,
      keyScope: SCOPE,
    });
    try {
      await client.ready();
      assert.equal((await client.start({
        ...SCOPE,
        announcedProjectId: "00000000-0000-4000-8000-000000000199",
      })).type, "started");

      const duplicate = await client.mutation({ operation: "duplicate" });
      assert.equal(duplicate.type, "result");
      assert.deepEqual(duplicate.value, {
        first: "ok",
        second: "FIXTURE_KEY_REQUEST_DUPLICATE",
      });
      assert.equal(broker.calls.length, 1);
      assert.deepEqual(broker.calls[0], {
        operation: "currentKey",
        projectId: SCOPE.projectId,
        storeId: SCOPE.storeId,
        purpose: "root-session-handle",
        keyId: "fixture-root-session-handle-001",
        domain: null,
        byteLength: null,
      });
    } finally {
      broker.shutdown();
    }
  });
});
