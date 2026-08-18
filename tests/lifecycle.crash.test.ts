import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";
import { LifecycleFixtureClient } from "./support/lifecycle-fixture-client.js";
import { LifecycleTestKeyBroker } from "./support/lifecycle-test-key-broker.js";

const FIXTURE_PATH = fileURLToPath(new URL("./fixtures/project-store-lifecycle-child.js", import.meta.url));
const ATOMIC_CRASH_FIXTURE_PATH = fileURLToPath(
  new URL("./fixtures/project-store-lifecycle-crash-child.js", import.meta.url),
);
const VALIDATION_FIXTURE_PATH = fileURLToPath(
  new URL("./fixtures/lifecycle-validation-profile-child.js", import.meta.url),
);
const clients = new Set<LifecycleFixtureClient>();
const roots: string[] = [];

afterEach(async () => {
  await Promise.all([...clients].map(async (client) => {
    try { await client.dispose(); } catch { await client.forceCleanup(); }
  }));
  clients.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function valueOf(message: { readonly type: string; readonly value?: unknown }): Record<string, unknown> {
  assert.equal(message.type, "result", JSON.stringify(message));
  assert.ok(message.value !== null && typeof message.value === "object");
  return message.value as Record<string, unknown>;
}

function countRows(
  eventsPath: string,
  table: "events" | "command_dedup" | "session_authority" | "workflow_instances",
): number {
  const database = new DatabaseSync(eventsPath, { readOnly: true });
  try {
    const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { readonly count: number };
    return row.count;
  } finally {
    database.close();
  }
}

function rootSemanticState(eventsPath: string): string {
  const database = new DatabaseSync(eventsPath, { readOnly: true });
  try {
    const rows = database.prepare(`
      SELECT semantic_state AS semanticState
      FROM session_authority
      WHERE session_kind = 'root'
      LIMIT 2
    `).all() as unknown as readonly { readonly semanticState: unknown }[];
    assert.equal(rows.length, 1);
    assert.equal(typeof rows[0]?.semanticState, "string");
    return rows[0]!.semanticState as string;
  } finally {
    database.close();
  }
}

function workflowPhase(eventsPath: string): string {
  const database = new DatabaseSync(eventsPath, { readOnly: true });
  try {
    const rows = database.prepare(`
      SELECT phase
      FROM workflow_instances
      WHERE workflow_type = 'session-end'
      LIMIT 2
    `).all() as unknown as readonly { readonly phase: unknown }[];
    assert.equal(rows.length, 1);
    assert.equal(typeof rows[0]?.phase, "string");
    return rows[0]!.phase as string;
  } finally {
    database.close();
  }
}

function lifecycleOutboxRows(eventsPath: string): readonly {
  readonly targetKey: string;
  readonly materializationRevision: string;
  readonly artifactPath: string;
  readonly status: string;
}[] {
  const database = new DatabaseSync(eventsPath, { readOnly: true });
  try {
    return database.prepare(`
      SELECT
        target_key AS targetKey,
        materialization_revision AS materializationRevision,
        artifact_path AS artifactPath,
        status
      FROM outbox
      WHERE origin_kind = 'workflow'
      ORDER BY materialization_revision ASC
    `).all().map((row) => {
      const targetKey = row.targetKey;
      const materializationRevision = row.materializationRevision;
      const artifactPath = row.artifactPath;
      const status = row.status;
      if (typeof targetKey !== "string"
        || (typeof materializationRevision !== "bigint" && typeof materializationRevision !== "number")
        || typeof artifactPath !== "string"
        || typeof status !== "string") {
        assert.fail("invalid lifecycle outbox row");
      }
      return {
        targetKey,
        materializationRevision: String(materializationRevision),
        artifactPath,
        status,
      };
    });
  } finally {
    database.close();
  }
}

describe("Task 18 lifecycle crash recovery", () => {
  it("materializes a real session-end final checkpoint through a fenced outbox claim and exact replay", async () => {
    const root = mkdtempSync(join(tmpdir(), "task18-session-end-outbox-"));
    roots.push(root);
    const projectRoot = join(root, "project");
    const vaultRoot = join(projectRoot, "memory");
    mkdirSync(vaultRoot, { recursive: true });
    const broker = new LifecycleTestKeyBroker({ seed: "task18-session-end-outbox-broker" });
    const rootStart = {
      operation: "root-start",
      commandId: randomUUID(),
      continuityKey: "task18-session-end-outbox-root",
      idempotencyKey: "task18-session-end-outbox-root-start",
    };
    const request = {
      operation: "request-session-end",
      commandId: randomUUID(),
      idempotencyKey: "task18-session-end-outbox-request",
      proofNonce: randomUUID(),
    };
    const driver = {
      operation: "drive-session-end",
      ownerId: "18180000-0000-4000-8000-000000000001",
      observedNowMs: String(Date.now()),
      leaseDurationMs: "30000",
    };
    try {
      const client = new LifecycleFixtureClient({
        fixturePath: FIXTURE_PATH,
        timeoutMs: 20_000,
        cleanupTimeoutMs: 20_000,
        keyBroker: broker,
      });
      clients.add(client);
      await client.ready();
      const started = await client.start({
        projectRoot,
        vaultRoot,
        clientInstanceId: "task18-session-end-outbox",
        useParentKeyBroker: true,
      });
      assert.equal(started.type, "started");
      const eventsPath = (started.payload as Record<string, unknown>).eventsPath;
      if (typeof eventsPath !== "string") assert.fail("fixture did not report eventsPath");
      assert.equal((valueOf(await client.mutation(rootStart)).result as Record<string, unknown>).kind, "success");
      assert.equal(valueOf(await client.mutation({ operation: "record-root-checkpoint" })).operation, "record-root-checkpoint");
      const requested = valueOf(await client.mutation(request));
      assert.equal(requested.operation, "request-session-end");
      const requestedPublic = (requested.result as Record<string, unknown>).publicResult as Record<string, unknown>;
      const workflowId = requestedPublic.workflowId;
      if (typeof workflowId !== "string") assert.fail("session-end request did not return a workflow id");
      assert.match(workflowId, /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u, JSON.stringify(requestedPublic));

      const childrenResolved = valueOf(await client.mutation(driver));
      assert.equal(
        ((childrenResolved.result as Record<string, unknown>).publicResult as Record<string, unknown>).phase,
        "children-resolved",
      );
      const sealed = valueOf(await client.mutation({
        operation: "seal-session-end",
        commandId: randomUUID(),
        idempotencyKey: "task18-session-end-outbox-seal",
        proofNonce: randomUUID(),
        workflowId,
        expectedStreamVersion: "3",
      }));
      assert.equal(sealed.operation, "seal-session-end");
      const finalCheckpoint = valueOf(await client.mutation({
        ...driver,
        observedNowMs: String(Date.now()),
      }));
      assert.equal(
        ((finalCheckpoint.result as Record<string, unknown>).publicResult as Record<string, unknown>).phase,
        "final-checkpoint-recorded",
      );

      const pending = lifecycleOutboxRows(eventsPath);
      assert.equal(pending.length, 2, JSON.stringify(pending));
      assert.deepEqual(pending.map((row) => row.status), ["pending", "pending"]);
      const finalPending = pending[1];
      if (finalPending === undefined) assert.fail("final lifecycle outbox row was not written");
      const claimRequest = {
        operation: "outbox-claim-next",
        workId: "task18-session-end-outbox-claim",
        ownerId: "task18-session-end-outbox-materializer",
        observedNowMs: String(Date.now()),
        ttlMs: "30000",
      };
      const claimResponse = valueOf(await client.mutation(claimRequest));
      const claim = (claimResponse.result as Record<string, unknown>).publicResult as Record<string, unknown>;
      assert.equal(claim.targetKey, finalPending.targetKey);
      assert.equal(claim.materializationRevision, finalPending.materializationRevision);
      assert.equal(typeof claim.claimToken, "string");
      if (typeof claim.claimToken !== "string"
        || typeof claim.targetKey !== "string"
        || typeof claim.materializationRevision !== "string") {
        assert.fail("fixture did not return a complete outbox claim");
      }

      const materialize = {
        operation: "outbox-materialize",
        workId: "task18-session-end-outbox-materialize",
        ownerId: claimRequest.ownerId,
        fencingToken: claim.claimToken,
        targetKey: claim.targetKey,
        materializationRevision: claim.materializationRevision,
      };
      const completed = valueOf(await client.mutation(materialize));
      assert.equal((completed.result as Record<string, unknown>).publicResult !== null, true);
      const completedPublic = (completed.result as Record<string, unknown>).publicResult as Record<string, unknown>;
      assert.equal(completedPublic.status, "completed");
      assert.equal(completedPublic.acknowledged, true);
      const replay = valueOf(await client.mutation(materialize));
      assert.deepEqual(replay, completed);
      assert.deepEqual(lifecycleOutboxRows(eventsPath).map((row) => row.status), ["pending", "completed"]);
      assert.equal(existsSync(join(vaultRoot, finalPending.artifactPath)), true);
      await client.close();
      clients.delete(client);
      assert.equal(countRows(eventsPath, "events"), 5);
      assert.equal(countRows(eventsPath, "command_dedup"), 5);
      assert.equal(countRows(eventsPath, "workflow_instances"), 1);
    } finally {
      broker.shutdown();
    }
  });

  it("reuses one real validation attempt identity after each external crash boundary", async () => {
    const canary = "TASK18_VALIDATION_RESTART_CANARY";
    let stableResultId: string | undefined;
    for (const point of [
      "before-external-start",
      "after-external-complete-before-result-commit",
    ] as const) {
      const first = new LifecycleFixtureClient({
        fixturePath: VALIDATION_FIXTURE_PATH,
        timeoutMs: 10_000,
        cleanupTimeoutMs: 10_000,
      });
      clients.add(first);
      await first.ready();
      assert.equal((await first.start({ projectId: "task18-validation-crash" })).type, "started");
      assert.deepEqual(valueOf(await first.fault({ boundary: "validation-result", point })), {
        boundary: "validation-result",
        point,
        armed: true,
      });
      await assert.rejects(first.validation({ output: canary }), /fixture exited before barrier|fixture exited before validation/i);
      assert.deepEqual(await first.forceCleanup(), { code: 137, signal: null });
      clients.delete(first);

      const retry = new LifecycleFixtureClient({
        fixturePath: VALIDATION_FIXTURE_PATH,
        timeoutMs: 10_000,
        cleanupTimeoutMs: 10_000,
      });
      clients.add(retry);
      await retry.ready();
      assert.equal((await retry.start({ projectId: "task18-validation-crash" })).type, "started");
      const replay = valueOf(await retry.validation({ output: canary }));
      assert.equal(replay.status, "pass");
      assert.equal(replay.contentRetained, false);
      assert.equal(typeof replay.resultId, "string");
      if (stableResultId === undefined) stableResultId = replay.resultId as string;
      else assert.equal(replay.resultId, stableResultId);
      assert.equal(JSON.stringify(replay).includes(canary), false);
      await retry.close();
      clients.delete(retry);
    }
  });

  it("recovers each real atomic artifact crash boundary through a clean retry", async () => {
    const cases = [
      {
        boundary: "temporary-file-write",
        point: "before-temp-write",
        beforeRetry: "prior artifact bytes",
      },
      {
        boundary: "temporary-file-write",
        point: "after-temp-fsync-before-replace",
        beforeRetry: "prior artifact bytes",
      },
      {
        boundary: "artifact-replace",
        point: "after-replace-before-ack",
        beforeRetry: "committed artifact bytes",
      },
    ] as const;
    for (const fixtureCase of cases) {
      const root = mkdtempSync(join(tmpdir(), `task18-atomic-${fixtureCase.point}-`));
      roots.push(root);
      const targetPath = join(root, "artifact.md");
      const tempPath = join(root, ".artifact.task18.tmp");
      writeFileSync(targetPath, "prior artifact bytes", "utf8");
      const request = {
        operation: "atomic-replace",
        durableBase: root,
        targetPath,
        tempPath,
        content: "committed artifact bytes",
      };
      const first = new LifecycleFixtureClient({
        fixturePath: ATOMIC_CRASH_FIXTURE_PATH,
        timeoutMs: 10_000,
        cleanupTimeoutMs: 10_000,
      });
      clients.add(first);
      await first.ready();
      assert.equal((await first.start({})).type, "started");
      assert.deepEqual(valueOf(await first.fault({
        boundary: fixtureCase.boundary,
        point: fixtureCase.point,
      })), {
        boundary: fixtureCase.boundary,
        point: fixtureCase.point,
        armed: true,
      });
      await assert.rejects(first.mutation(request), /fixture exited before barrier|fixture exited before mutation/i);
      assert.deepEqual(await first.forceCleanup(), { code: 137, signal: null });
      clients.delete(first);
      assert.equal(readFileSync(targetPath, "utf8"), fixtureCase.beforeRetry, fixtureCase.point);

      const retry = new LifecycleFixtureClient({
        fixturePath: ATOMIC_CRASH_FIXTURE_PATH,
        timeoutMs: 10_000,
        cleanupTimeoutMs: 10_000,
      });
      clients.add(retry);
      await retry.ready();
      assert.equal((await retry.start({})).type, "started");
      const replay = valueOf(await retry.mutation(request));
      assert.equal(replay.operation, "atomic-replace");
      assert.equal(replay.replaced, true);
      await retry.close();
      clients.delete(retry);
      assert.equal(readFileSync(targetPath, "utf8"), "committed artifact bytes", fixtureCase.point);
      assert.equal(existsSync(tempPath), false, fixtureCase.point);
    }
  });

  it("retries one real fenced recovery after a committed operational response loss", async () => {
    const root = mkdtempSync(join(tmpdir(), "task18-operational-crash-"));
    roots.push(root);
    const projectRoot = join(root, "project");
    const vaultRoot = join(projectRoot, "memory");
    mkdirSync(vaultRoot, { recursive: true });
    const recovery = {
      operation: "workflow-recovery",
      workId: "task18-operational-crash-work",
      ownerId: "task18-operational-crash-owner",
      fencingToken: "1",
      dueBefore: "2026-08-17T00:00:00.000Z",
      limit: 10,
    };
    let eventsPath = "";
    const first = new LifecycleFixtureClient({
      fixturePath: FIXTURE_PATH,
      timeoutMs: 15_000,
      cleanupTimeoutMs: 15_000,
    });
    clients.add(first);
    try {
      await first.ready();
      const started = await first.start({
        projectRoot,
        vaultRoot,
        clientInstanceId: "task18-operational-crash",
      });
      assert.equal(started.type, "started");
      eventsPath = (started.payload as Record<string, unknown>).eventsPath as string;
      const selected = valueOf(await first.fault({
        boundary: "ownership-recovery",
        point: "after-commit-before-response",
      }));
      assert.deepEqual(selected, {
        boundary: "ownership-recovery",
        point: "after-commit-before-response",
        armed: true,
      });
      await assert.rejects(first.mutation(recovery), /fixture exited before barrier|fixture exited before mutation/i);
      assert.deepEqual(await first.forceCleanup(), { code: 137, signal: null });
      clients.delete(first);

      const retry = new LifecycleFixtureClient({
        fixturePath: FIXTURE_PATH,
        timeoutMs: 15_000,
        cleanupTimeoutMs: 15_000,
      });
      clients.add(retry);
      await retry.ready();
      assert.equal((await retry.start({
        projectRoot,
        vaultRoot,
        clientInstanceId: "task18-operational-crash",
      })).type, "started");
      const result = valueOf(await retry.mutation(recovery));
      assert.equal((result.result as Record<string, unknown>).readOnly, true);
      assert.equal((result.result as Record<string, unknown>).integrityOk, true);
      await retry.close();
      clients.delete(retry);

      assert.equal(countRows(eventsPath, "events"), 0);
      assert.equal(countRows(eventsPath, "command_dedup"), 0);
      assert.equal(countRows(eventsPath, "session_authority"), 0);
    } finally {
      try { await first.dispose(); } catch { await first.forceCleanup(); }
    }
  });

  it("replays exactly one child fork after its committed response is lost", async () => {
    const root = mkdtempSync(join(tmpdir(), "task18-child-fork-crash-"));
    roots.push(root);
    const projectRoot = join(root, "project");
    const vaultRoot = join(projectRoot, "memory");
    mkdirSync(vaultRoot, { recursive: true });
    const broker = new LifecycleTestKeyBroker({ seed: "task18-child-fork-crash-broker" });
    const rootStart = {
      operation: "root-start",
      commandId: randomUUID(),
      continuityKey: "task18-child-fork-crash-root",
      idempotencyKey: "task18-child-fork-crash-root-start",
    };
    const fork = {
      operation: "fork-children",
      count: 1,
      commandId: randomUUID(),
      idempotencyKey: "task18-child-fork-crash-fork",
      assignmentId: randomUUID(),
      proofNonce: randomUUID(),
    };
    let eventsPath = "";
    try {
      const first = new LifecycleFixtureClient({
        fixturePath: FIXTURE_PATH,
        timeoutMs: 15_000,
        cleanupTimeoutMs: 15_000,
        keyBroker: broker,
      });
      clients.add(first);
      await first.ready();
      const started = await first.start({
        projectRoot,
        vaultRoot,
        clientInstanceId: "task18-child-fork-crash",
        useParentKeyBroker: true,
      });
      assert.equal(started.type, "started");
      eventsPath = (started.payload as Record<string, unknown>).eventsPath as string;
      assert.equal((valueOf(await first.mutation(rootStart)).result as Record<string, unknown>).kind, "success");
      assert.equal((await first.fault({
        boundary: "event-append",
        point: "after-commit-before-response",
      })).type, "result");
      await assert.rejects(first.mutation(fork), /fixture exited before barrier|fixture exited before mutation/i);
      assert.deepEqual(await first.forceCleanup(), { code: 137, signal: null });
      clients.delete(first);

      assert.equal(countRows(eventsPath, "events"), 2);
      assert.equal(countRows(eventsPath, "command_dedup"), 2);
      assert.equal(countRows(eventsPath, "session_authority"), 2);

      const retry = new LifecycleFixtureClient({
        fixturePath: FIXTURE_PATH,
        timeoutMs: 15_000,
        cleanupTimeoutMs: 15_000,
        keyBroker: broker,
      });
      clients.add(retry);
      await retry.ready();
      assert.equal((await retry.start({
        projectRoot,
        vaultRoot,
        clientInstanceId: "task18-child-fork-crash",
        useParentKeyBroker: true,
      })).type, "started");
      assert.equal((valueOf(await retry.mutation(rootStart)).result as Record<string, unknown>).kind, "success");
      const replay = valueOf(await retry.mutation(fork));
      assert.equal(replay.childCount, 1);
      await retry.close();
      clients.delete(retry);

      assert.equal(countRows(eventsPath, "events"), 2);
      assert.equal(countRows(eventsPath, "command_dedup"), 2);
      assert.equal(countRows(eventsPath, "session_authority"), 2);
    } finally {
      broker.shutdown();
    }
  });

  it("replays one real session-end request after its committed response is lost", async () => {
    const root = mkdtempSync(join(tmpdir(), "task18-session-end-crash-"));
    roots.push(root);
    const projectRoot = join(root, "project");
    const vaultRoot = join(projectRoot, "memory");
    mkdirSync(vaultRoot, { recursive: true });
    const broker = new LifecycleTestKeyBroker({ seed: "task18-session-end-crash-broker" });
    const rootStart = {
      operation: "root-start",
      commandId: randomUUID(),
      continuityKey: "task18-session-end-crash-root",
      idempotencyKey: "task18-session-end-crash-root-start",
    };
    const request = {
      operation: "request-session-end",
      commandId: randomUUID(),
      idempotencyKey: "task18-session-end-crash-request",
      proofNonce: randomUUID(),
    };
    let eventsPath = "";
    try {
      const first = new LifecycleFixtureClient({
        fixturePath: FIXTURE_PATH,
        timeoutMs: 20_000,
        cleanupTimeoutMs: 20_000,
        keyBroker: broker,
      });
      clients.add(first);
      await first.ready();
      const started = await first.start({
        projectRoot,
        vaultRoot,
        clientInstanceId: "task18-session-end-crash",
        useParentKeyBroker: true,
      });
      assert.equal(started.type, "started");
      eventsPath = (started.payload as Record<string, unknown>).eventsPath as string;
      assert.equal((valueOf(await first.mutation(rootStart)).result as Record<string, unknown>).kind, "success");
      assert.equal(valueOf(await first.mutation({ operation: "record-root-checkpoint" })).operation, "record-root-checkpoint");
      assert.deepEqual(valueOf(await first.fault({
        boundary: "event-append",
        point: "after-commit-before-response",
      })), {
        boundary: "event-append",
        point: "after-commit-before-response",
        armed: true,
      });
      await assert.rejects(first.mutation(request), /fixture exited before barrier|fixture exited before mutation/i);
      assert.deepEqual(await first.forceCleanup(), { code: 137, signal: null });
      clients.delete(first);

      assert.equal(countRows(eventsPath, "events"), 3);
      assert.equal(countRows(eventsPath, "command_dedup"), 3);
      assert.equal(countRows(eventsPath, "workflow_instances"), 1);

      const retry = new LifecycleFixtureClient({
        fixturePath: FIXTURE_PATH,
        timeoutMs: 20_000,
        cleanupTimeoutMs: 20_000,
        keyBroker: broker,
      });
      clients.add(retry);
      await retry.ready();
      assert.equal((await retry.start({
        projectRoot,
        vaultRoot,
        clientInstanceId: "task18-session-end-crash",
        useParentKeyBroker: true,
      })).type, "started");
      assert.equal((valueOf(await retry.mutation(rootStart)).result as Record<string, unknown>).kind, "success");
      const replay = valueOf(await retry.mutation(request));
      assert.equal(replay.operation, "request-session-end");
      const execution = replay.result as Record<string, unknown>;
      assert.equal(execution.kind, "success");
      assert.equal((execution.publicResult as Record<string, unknown>).phase, "requested");
      await retry.close();
      clients.delete(retry);

      assert.equal(countRows(eventsPath, "events"), 3);
      assert.equal(countRows(eventsPath, "command_dedup"), 3);
      assert.equal(countRows(eventsPath, "workflow_instances"), 1);
    } finally {
      broker.shutdown();
    }
  });

  it("crashes before an injected workflow-create write and recovers the exact end request", async () => {
    const root = mkdtempSync(join(tmpdir(), "task18-workflow-create-crash-"));
    roots.push(root);
    const projectRoot = join(root, "project");
    const vaultRoot = join(projectRoot, "memory");
    mkdirSync(vaultRoot, { recursive: true });
    const broker = new LifecycleTestKeyBroker({ seed: "task18-workflow-create-crash-broker" });
    const rootStart = {
      operation: "root-start",
      commandId: randomUUID(),
      continuityKey: "task18-workflow-create-crash-root",
      idempotencyKey: "task18-workflow-create-crash-root-start",
    };
    const request = {
      operation: "request-session-end",
      commandId: randomUUID(),
      idempotencyKey: "task18-workflow-create-crash-request",
      proofNonce: randomUUID(),
    };
    let eventsPath = "";
    try {
      const first = new LifecycleFixtureClient({
        fixturePath: FIXTURE_PATH,
        timeoutMs: 20_000,
        cleanupTimeoutMs: 20_000,
        keyBroker: broker,
      });
      clients.add(first);
      await first.ready();
      const started = await first.start({
        projectRoot,
        vaultRoot,
        clientInstanceId: "task18-workflow-create-crash",
        useParentKeyBroker: true,
      });
      assert.equal(started.type, "started");
      eventsPath = (started.payload as Record<string, unknown>).eventsPath as string;
      assert.equal((valueOf(await first.mutation(rootStart)).result as Record<string, unknown>).kind, "success");
      assert.equal(valueOf(await first.mutation({ operation: "record-root-checkpoint" })).operation, "record-root-checkpoint");
      assert.deepEqual(valueOf(await first.fault({
        boundary: "workflow-create",
        point: "before-write",
      })), {
        boundary: "workflow-create",
        point: "before-write",
        armed: true,
      });
      await assert.rejects(first.mutation(request), /fixture exited before barrier|fixture exited before mutation/i);
      assert.deepEqual(await first.forceCleanup(), { code: 137, signal: null });
      clients.delete(first);

      assert.equal(countRows(eventsPath, "events"), 2);
      assert.equal(countRows(eventsPath, "command_dedup"), 2);
      assert.equal(countRows(eventsPath, "workflow_instances"), 0);
      assert.equal(rootSemanticState(eventsPath), "active");

      const retry = new LifecycleFixtureClient({
        fixturePath: FIXTURE_PATH,
        timeoutMs: 20_000,
        cleanupTimeoutMs: 20_000,
        keyBroker: broker,
      });
      clients.add(retry);
      await retry.ready();
      assert.equal((await retry.start({
        projectRoot,
        vaultRoot,
        clientInstanceId: "task18-workflow-create-crash",
        useParentKeyBroker: true,
      })).type, "started");
      assert.equal((valueOf(await retry.mutation(rootStart)).result as Record<string, unknown>).kind, "success");
      const replay = valueOf(await retry.mutation(request));
      assert.equal(replay.operation, "request-session-end");
      const execution = replay.result as Record<string, unknown>;
      assert.equal(execution.kind, "success");
      assert.equal((execution.publicResult as Record<string, unknown>).phase, "requested");
      await retry.close();
      clients.delete(retry);

      assert.equal(countRows(eventsPath, "events"), 3);
      assert.equal(countRows(eventsPath, "command_dedup"), 3);
      assert.equal(countRows(eventsPath, "workflow_instances"), 1);
    } finally {
      broker.shutdown();
    }
  });

  it("crashes at every pre-commit final checkpoint boundary and retries the fenced phase once", async () => {
    for (const point of ["before-write", "after-write-before-commit"] as const) {
    const root = mkdtempSync(join(tmpdir(), "task18-final-checkpoint-crash-"));
    roots.push(root);
    const projectRoot = join(root, "project");
    const vaultRoot = join(projectRoot, "memory");
    mkdirSync(vaultRoot, { recursive: true });
    const broker = new LifecycleTestKeyBroker({ seed: "task18-final-checkpoint-crash-broker" });
    const rootStart = {
      operation: "root-start",
      commandId: randomUUID(),
      continuityKey: "task18-final-checkpoint-crash-root",
      idempotencyKey: "task18-final-checkpoint-crash-root-start",
    };
    const request = {
      operation: "request-session-end",
      commandId: randomUUID(),
      idempotencyKey: "task18-final-checkpoint-crash-request",
      proofNonce: randomUUID(),
    };
    const driver = {
      operation: "drive-session-end",
      ownerId: "18180000-0000-4000-8000-000000000002",
      observedNowMs: String(Date.now()),
      leaseDurationMs: "30000",
    };
    let eventsPath = "";
    try {
      const first = new LifecycleFixtureClient({
        fixturePath: FIXTURE_PATH,
        timeoutMs: 20_000,
        cleanupTimeoutMs: 20_000,
        keyBroker: broker,
      });
      clients.add(first);
      await first.ready();
      const started = await first.start({
        projectRoot,
        vaultRoot,
        clientInstanceId: "task18-final-checkpoint-crash",
        useParentKeyBroker: true,
      });
      assert.equal(started.type, "started");
      eventsPath = (started.payload as Record<string, unknown>).eventsPath as string;
      assert.equal((valueOf(await first.mutation(rootStart)).result as Record<string, unknown>).kind, "success");
      assert.equal(valueOf(await first.mutation({ operation: "record-root-checkpoint" })).operation, "record-root-checkpoint");
      const requested = valueOf(await first.mutation(request));
      const workflowId = ((requested.result as Record<string, unknown>).publicResult as Record<string, unknown>).workflowId;
      if (typeof workflowId !== "string") assert.fail("session-end request did not return a workflow id");
      assert.equal(
        ((valueOf(await first.mutation(driver)).result as Record<string, unknown>).publicResult as Record<string, unknown>).phase,
        "children-resolved",
      );
      assert.equal(valueOf(await first.mutation({
        operation: "seal-session-end",
        commandId: randomUUID(),
        idempotencyKey: "task18-final-checkpoint-crash-seal",
        proofNonce: randomUUID(),
        workflowId,
        expectedStreamVersion: "3",
      })).operation, "seal-session-end");
      assert.deepEqual(valueOf(await first.fault({
        boundary: "final-checkpoint",
        point,
      })), {
        boundary: "final-checkpoint",
        point,
        armed: true,
      });
      await assert.rejects(
        first.mutation({ ...driver, observedNowMs: String(Date.now()) }),
        /fixture exited before barrier|fixture exited before mutation/i,
      );
      assert.deepEqual(await first.forceCleanup(), { code: 137, signal: null });
      clients.delete(first);

      assert.equal(workflowPhase(eventsPath), "children-resolved");
      assert.equal(countRows(eventsPath, "events"), 4);

      const retry = new LifecycleFixtureClient({
        fixturePath: FIXTURE_PATH,
        timeoutMs: 20_000,
        cleanupTimeoutMs: 20_000,
        keyBroker: broker,
      });
      clients.add(retry);
      await retry.ready();
      assert.equal((await retry.start({
        projectRoot,
        vaultRoot,
        clientInstanceId: "task18-final-checkpoint-crash",
        useParentKeyBroker: true,
      })).type, "started");
      assert.equal((valueOf(await retry.mutation(rootStart)).result as Record<string, unknown>).kind, "success");
      const replay = valueOf(await retry.mutation({
        ...driver,
        observedNowMs: String(Date.now() + 60_000),
      }));
      assert.equal(replay.operation, "drive-session-end");
      assert.equal(
        ((replay.result as Record<string, unknown>).publicResult as Record<string, unknown>).phase,
        "final-checkpoint-recorded",
      );
      await retry.close();
      clients.delete(retry);

      assert.equal(workflowPhase(eventsPath), "final-checkpoint-recorded");
      assert.equal(countRows(eventsPath, "events"), 5);
    } finally {
      broker.shutdown();
    }
    }
  });

  it("crashes before inserting the final checkpoint outbox row and retries the phase once", async () => {
    const root = mkdtempSync(join(tmpdir(), "task18-outbox-insert-crash-"));
    roots.push(root);
    const projectRoot = join(root, "project");
    const vaultRoot = join(projectRoot, "memory");
    mkdirSync(vaultRoot, { recursive: true });
    const broker = new LifecycleTestKeyBroker({ seed: "task18-outbox-insert-crash-broker" });
    const rootStart = {
      operation: "root-start",
      commandId: randomUUID(),
      continuityKey: "task18-outbox-insert-crash-root",
      idempotencyKey: "task18-outbox-insert-crash-root-start",
    };
    const request = {
      operation: "request-session-end",
      commandId: randomUUID(),
      idempotencyKey: "task18-outbox-insert-crash-request",
      proofNonce: randomUUID(),
    };
    const driver = {
      operation: "drive-session-end",
      ownerId: "18180000-0000-4000-8000-000000000003",
      observedNowMs: String(Date.now()),
      leaseDurationMs: "30000",
    };
    let eventsPath = "";
    try {
      const first = new LifecycleFixtureClient({
        fixturePath: FIXTURE_PATH,
        timeoutMs: 20_000,
        cleanupTimeoutMs: 20_000,
        keyBroker: broker,
      });
      clients.add(first);
      await first.ready();
      const started = await first.start({
        projectRoot,
        vaultRoot,
        clientInstanceId: "task18-outbox-insert-crash",
        useParentKeyBroker: true,
      });
      assert.equal(started.type, "started");
      eventsPath = (started.payload as Record<string, unknown>).eventsPath as string;
      assert.equal((valueOf(await first.mutation(rootStart)).result as Record<string, unknown>).kind, "success");
      assert.equal(valueOf(await first.mutation({ operation: "record-root-checkpoint" })).operation, "record-root-checkpoint");
      const requested = valueOf(await first.mutation(request));
      const workflowId = ((requested.result as Record<string, unknown>).publicResult as Record<string, unknown>).workflowId;
      if (typeof workflowId !== "string") assert.fail("session-end request did not return a workflow id");
      assert.equal(
        ((valueOf(await first.mutation(driver)).result as Record<string, unknown>).publicResult as Record<string, unknown>).phase,
        "children-resolved",
      );
      assert.equal(valueOf(await first.mutation({
        operation: "seal-session-end",
        commandId: randomUUID(),
        idempotencyKey: "task18-outbox-insert-crash-seal",
        proofNonce: randomUUID(),
        workflowId,
        expectedStreamVersion: "3",
      })).operation, "seal-session-end");
      assert.deepEqual(valueOf(await first.fault({
        boundary: "outbox-insert",
        point: "before-write",
      })), {
        boundary: "outbox-insert",
        point: "before-write",
        armed: true,
      });
      await assert.rejects(
        first.mutation({ ...driver, observedNowMs: String(Date.now()) }),
        /fixture exited before barrier|fixture exited before mutation/i,
      );
      assert.deepEqual(await first.forceCleanup(), { code: 137, signal: null });
      clients.delete(first);

      assert.equal(workflowPhase(eventsPath), "children-resolved");
      assert.equal(countRows(eventsPath, "events"), 4);
      assert.equal(lifecycleOutboxRows(eventsPath).length, 1);

      const retry = new LifecycleFixtureClient({
        fixturePath: FIXTURE_PATH,
        timeoutMs: 20_000,
        cleanupTimeoutMs: 20_000,
        keyBroker: broker,
      });
      clients.add(retry);
      await retry.ready();
      assert.equal((await retry.start({
        projectRoot,
        vaultRoot,
        clientInstanceId: "task18-outbox-insert-crash",
        useParentKeyBroker: true,
      })).type, "started");
      assert.equal((valueOf(await retry.mutation(rootStart)).result as Record<string, unknown>).kind, "success");
      const replay = valueOf(await retry.mutation({
        ...driver,
        observedNowMs: String(Date.now() + 60_000),
      }));
      assert.equal(replay.operation, "drive-session-end");
      assert.equal(
        ((replay.result as Record<string, unknown>).publicResult as Record<string, unknown>).phase,
        "final-checkpoint-recorded",
      );
      await retry.close();
      clients.delete(retry);

      assert.equal(workflowPhase(eventsPath), "final-checkpoint-recorded");
      assert.equal(countRows(eventsPath, "events"), 5);
      assert.equal(lifecycleOutboxRows(eventsPath).length, 2);
    } finally {
      broker.shutdown();
    }
  });

  it("crashes before an injected workflow-phase write and retries the operational phase once", async () => {
    const root = mkdtempSync(join(tmpdir(), "task18-workflow-phase-crash-"));
    roots.push(root);
    const projectRoot = join(root, "project");
    const vaultRoot = join(projectRoot, "memory");
    mkdirSync(vaultRoot, { recursive: true });
    const broker = new LifecycleTestKeyBroker({ seed: "task18-workflow-phase-crash-broker" });
    const rootStart = {
      operation: "root-start",
      commandId: randomUUID(),
      continuityKey: "task18-workflow-phase-crash-root",
      idempotencyKey: "task18-workflow-phase-crash-root-start",
    };
    const request = {
      operation: "request-session-end",
      commandId: randomUUID(),
      idempotencyKey: "task18-workflow-phase-crash-request",
      proofNonce: randomUUID(),
    };
    const driver = {
      operation: "drive-session-end",
      ownerId: "18180000-0000-4000-8000-000000000004",
      observedNowMs: String(Date.now()),
      leaseDurationMs: "30000",
    };
    let eventsPath = "";
    try {
      const first = new LifecycleFixtureClient({
        fixturePath: FIXTURE_PATH,
        timeoutMs: 20_000,
        cleanupTimeoutMs: 20_000,
        keyBroker: broker,
      });
      clients.add(first);
      await first.ready();
      const started = await first.start({
        projectRoot,
        vaultRoot,
        clientInstanceId: "task18-workflow-phase-crash",
        useParentKeyBroker: true,
      });
      assert.equal(started.type, "started");
      eventsPath = (started.payload as Record<string, unknown>).eventsPath as string;
      assert.equal((valueOf(await first.mutation(rootStart)).result as Record<string, unknown>).kind, "success");
      assert.equal(valueOf(await first.mutation({ operation: "record-root-checkpoint" })).operation, "record-root-checkpoint");
      assert.equal(valueOf(await first.mutation(request)).operation, "request-session-end");
      assert.deepEqual(valueOf(await first.fault({
        boundary: "workflow-phase",
        point: "before-write",
      })), {
        boundary: "workflow-phase",
        point: "before-write",
        armed: true,
      });
      await assert.rejects(first.mutation(driver), /fixture exited before barrier|fixture exited before mutation/i);
      assert.deepEqual(await first.forceCleanup(), { code: 137, signal: null });
      clients.delete(first);

      assert.equal(workflowPhase(eventsPath), "requested");
      assert.equal(countRows(eventsPath, "events"), 3);

      const retry = new LifecycleFixtureClient({
        fixturePath: FIXTURE_PATH,
        timeoutMs: 20_000,
        cleanupTimeoutMs: 20_000,
        keyBroker: broker,
      });
      clients.add(retry);
      await retry.ready();
      assert.equal((await retry.start({
        projectRoot,
        vaultRoot,
        clientInstanceId: "task18-workflow-phase-crash",
        useParentKeyBroker: true,
      })).type, "started");
      assert.equal((valueOf(await retry.mutation(rootStart)).result as Record<string, unknown>).kind, "success");
      const replay = valueOf(await retry.mutation({
        ...driver,
        observedNowMs: String(Date.now() + 60_000),
      }));
      assert.equal(replay.operation, "drive-session-end");
      assert.equal(
        ((replay.result as Record<string, unknown>).publicResult as Record<string, unknown>).phase,
        "children-resolved",
      );
      await retry.close();
      clients.delete(retry);

      assert.equal(workflowPhase(eventsPath), "children-resolved");
      assert.equal(countRows(eventsPath, "events"), 3);
    } finally {
      broker.shutdown();
    }
  });

  it("reclaims one outbox row after the committed claim response is lost", async () => {
    const root = mkdtempSync(join(tmpdir(), "task18-outbox-claim-response-loss-"));
    roots.push(root);
    const projectRoot = join(root, "project");
    const vaultRoot = join(projectRoot, "memory");
    mkdirSync(vaultRoot, { recursive: true });
    const broker = new LifecycleTestKeyBroker({ seed: "task18-outbox-claim-response-loss-broker" });
    const rootStart = {
      operation: "root-start",
      commandId: randomUUID(),
      continuityKey: "task18-outbox-claim-response-loss-root",
      idempotencyKey: "task18-outbox-claim-response-loss-root-start",
    };
    const request = {
      operation: "request-session-end",
      commandId: randomUUID(),
      idempotencyKey: "task18-outbox-claim-response-loss-request",
      proofNonce: randomUUID(),
    };
    const driver = {
      operation: "drive-session-end",
      ownerId: "18180000-0000-4000-8000-000000000005",
      observedNowMs: String(Date.now()),
      leaseDurationMs: "30000",
    };
    const claimRequest = {
      operation: "outbox-claim-next",
      workId: "task18-outbox-claim-response-loss-work",
      ownerId: "task18-outbox-claim-response-loss-owner",
      observedNowMs: String(Date.now()),
      ttlMs: "30000",
    };
    let eventsPath = "";
    try {
      const first = new LifecycleFixtureClient({
        fixturePath: FIXTURE_PATH,
        timeoutMs: 20_000,
        cleanupTimeoutMs: 20_000,
        keyBroker: broker,
      });
      clients.add(first);
      await first.ready();
      const started = await first.start({
        projectRoot,
        vaultRoot,
        clientInstanceId: "task18-outbox-claim-response-loss",
        useParentKeyBroker: true,
      });
      assert.equal(started.type, "started");
      eventsPath = (started.payload as Record<string, unknown>).eventsPath as string;
      assert.equal((valueOf(await first.mutation(rootStart)).result as Record<string, unknown>).kind, "success");
      assert.equal(valueOf(await first.mutation({ operation: "record-root-checkpoint" })).operation, "record-root-checkpoint");
      const requested = valueOf(await first.mutation(request));
      const workflowId = ((requested.result as Record<string, unknown>).publicResult as Record<string, unknown>).workflowId;
      if (typeof workflowId !== "string") assert.fail("session-end request did not return a workflow id");
      assert.equal(
        ((valueOf(await first.mutation(driver)).result as Record<string, unknown>).publicResult as Record<string, unknown>).phase,
        "children-resolved",
      );
      assert.equal(valueOf(await first.mutation({
        operation: "seal-session-end",
        commandId: randomUUID(),
        idempotencyKey: "task18-outbox-claim-response-loss-seal",
        proofNonce: randomUUID(),
        workflowId,
        expectedStreamVersion: "3",
      })).operation, "seal-session-end");
      assert.equal(
        ((valueOf(await first.mutation({ ...driver, observedNowMs: String(Date.now()) })).result as Record<string, unknown>)
          .publicResult as Record<string, unknown>).phase,
        "final-checkpoint-recorded",
      );
      const planned = lifecycleOutboxRows(eventsPath);
      assert.equal(planned.length, 2);
      const finalPlanned = planned[1];
      if (finalPlanned === undefined) assert.fail("final checkpoint outbox row is missing");
      assert.deepEqual(valueOf(await first.fault({
        boundary: "outbox-claim",
        point: "after-commit-before-response",
      })), {
        boundary: "outbox-claim",
        point: "after-commit-before-response",
        armed: true,
      });
      await assert.rejects(first.mutation(claimRequest), /fixture exited before barrier|fixture exited before mutation/i);
      assert.deepEqual(await first.forceCleanup(), { code: 137, signal: null });
      clients.delete(first);

      assert.equal(countRows(eventsPath, "events"), 5);
      assert.deepEqual(lifecycleOutboxRows(eventsPath).map((row) => row.status), ["pending", "claimed"]);

      const retry = new LifecycleFixtureClient({
        fixturePath: FIXTURE_PATH,
        timeoutMs: 20_000,
        cleanupTimeoutMs: 20_000,
        keyBroker: broker,
      });
      clients.add(retry);
      await retry.ready();
      assert.equal((await retry.start({
        projectRoot,
        vaultRoot,
        clientInstanceId: "task18-outbox-claim-response-loss",
        useParentKeyBroker: true,
      })).type, "started");
      assert.equal((valueOf(await retry.mutation(rootStart)).result as Record<string, unknown>).kind, "success");
      const replay = valueOf(await retry.mutation({
        ...claimRequest,
        observedNowMs: String(Date.now() + 60_000),
      }));
      const claim = (replay.result as Record<string, unknown>).publicResult as Record<string, unknown>;
      assert.equal(claim.targetKey, finalPlanned.targetKey);
      assert.equal(claim.materializationRevision, finalPlanned.materializationRevision);
      assert.equal(claim.claimToken, "2");
      await retry.close();
      clients.delete(retry);

      assert.equal(countRows(eventsPath, "events"), 5);
      assert.deepEqual(lifecycleOutboxRows(eventsPath).map((row) => row.status), ["pending", "claimed"]);
    } finally {
      broker.shutdown();
    }
  });

  it("leaves zero semantic effect for each pre-commit root-start crash point", async () => {
    for (const point of ["before-write", "after-write-before-commit"] as const) {
      const root = mkdtempSync(join(tmpdir(), `task18-crash-${point}-`));
      roots.push(root);
      const projectRoot = join(root, "project");
      const vaultRoot = join(projectRoot, "memory");
      mkdirSync(vaultRoot, { recursive: true });
      const broker = new LifecycleTestKeyBroker({ seed: `task18-${point}-broker` });
      const commandId = randomUUID();
      const rootStart = {
        operation: "root-start",
        commandId,
        continuityKey: `task18-${point}-continuity`,
        idempotencyKey: `task18-${point}-idempotency`,
      };
      let eventsPath = "";
      try {
        const first = new LifecycleFixtureClient({
          fixturePath: FIXTURE_PATH,
          timeoutMs: 15_000,
          cleanupTimeoutMs: 15_000,
          keyBroker: broker,
        });
        clients.add(first);
        await first.ready();
        const started = await first.start({
          projectRoot,
          vaultRoot,
          clientInstanceId: `task18-${point}`,
          useParentKeyBroker: true,
        });
        assert.equal(started.type, "started");
        const startedPayload = started.payload as Record<string, unknown>;
        assert.equal(typeof startedPayload.eventsPath, "string");
        eventsPath = startedPayload.eventsPath as string;
        assert.equal((await first.fault({ boundary: "event-append", point })).type, "result");
        await assert.rejects(first.mutation(rootStart), /fixture exited before barrier|fixture exited before mutation/i);
        assert.deepEqual(await first.forceCleanup(), { code: 137, signal: null });
        clients.delete(first);

        assert.equal(countRows(eventsPath, "events"), 0, point);
        assert.equal(countRows(eventsPath, "command_dedup"), 0, point);
        assert.equal(countRows(eventsPath, "session_authority"), 0, point);

        const retry = new LifecycleFixtureClient({
          fixturePath: FIXTURE_PATH,
          timeoutMs: 15_000,
          cleanupTimeoutMs: 15_000,
          keyBroker: broker,
        });
        clients.add(retry);
        await retry.ready();
        assert.equal((await retry.start({
          projectRoot,
          vaultRoot,
          clientInstanceId: `task18-${point}`,
          useParentKeyBroker: true,
        })).type, "started");
        const replay = valueOf(await retry.mutation(rootStart));
        assert.equal((replay.result as Record<string, unknown>).kind, "success");
        await retry.close();
        clients.delete(retry);

        assert.equal(countRows(eventsPath, "events"), 1, point);
        assert.equal(countRows(eventsPath, "command_dedup"), 1, point);
        assert.equal(countRows(eventsPath, "session_authority"), 1, point);
      } finally {
        broker.shutdown();
      }
    }
  });

  it("replays exactly one real root start after a post-commit process loss", async () => {
    const root = mkdtempSync(join(tmpdir(), "task18-crash-replay-"));
    roots.push(root);
    const projectRoot = join(root, "project");
    const vaultRoot = join(projectRoot, "memory");
    mkdirSync(vaultRoot, { recursive: true });
    const broker = new LifecycleTestKeyBroker({ seed: "task18-crash-replay-broker" });
    const commandId = randomUUID();
    const rootStart = {
      operation: "root-start",
      commandId,
      continuityKey: "task18-crash-replay-continuity",
      idempotencyKey: "task18-crash-replay-idempotency",
    };
    let eventsPath = "";
    try {
      const first = new LifecycleFixtureClient({
        fixturePath: FIXTURE_PATH,
        timeoutMs: 15_000,
        cleanupTimeoutMs: 15_000,
        keyBroker: broker,
      });
      clients.add(first);
      await first.ready();
      const started = await first.start({
        projectRoot,
        vaultRoot,
        clientInstanceId: "task18-crash-replay",
        useParentKeyBroker: true,
      });
      assert.equal(started.type, "started");
      const startedPayload = started.payload as Record<string, unknown>;
      assert.equal(typeof startedPayload.eventsPath, "string");
      eventsPath = startedPayload.eventsPath as string;

      const selected = valueOf(await first.fault({
        boundary: "event-append",
        point: "after-commit-before-response",
      }));
      assert.deepEqual(selected, {
        boundary: "event-append",
        point: "after-commit-before-response",
        armed: true,
      });
      await assert.rejects(first.mutation(rootStart), /fixture exited before barrier|fixture exited before mutation/i);
      assert.deepEqual(await first.forceCleanup(), { code: 137, signal: null });
      clients.delete(first);

      const retry = new LifecycleFixtureClient({
        fixturePath: FIXTURE_PATH,
        timeoutMs: 15_000,
        cleanupTimeoutMs: 15_000,
        keyBroker: broker,
      });
      clients.add(retry);
      await retry.ready();
      assert.equal((await retry.start({
        projectRoot,
        vaultRoot,
        clientInstanceId: "task18-crash-replay",
        useParentKeyBroker: true,
      })).type, "started");
      const replay = valueOf(await retry.mutation(rootStart));
      assert.equal(replay.operation, "root-start");
      const execution = replay.result as Record<string, unknown>;
      assert.equal(execution.kind, "success");
      const publicResult = execution.publicResult as Record<string, unknown>;
      assert.equal(publicResult.state, "active");
      assert.equal(typeof publicResult.sessionId, "string");
      await retry.close();
      clients.delete(retry);

      assert.equal(countRows(eventsPath, "events"), 1);
      assert.equal(countRows(eventsPath, "command_dedup"), 1);
      assert.equal(countRows(eventsPath, "session_authority"), 1);
    } finally {
      broker.shutdown();
    }
  });

  it("replays exactly one root start when committed IPC response delivery is lost", async () => {
    const root = mkdtempSync(join(tmpdir(), "task18-response-delivery-replay-"));
    roots.push(root);
    const projectRoot = join(root, "project");
    const vaultRoot = join(projectRoot, "memory");
    mkdirSync(vaultRoot, { recursive: true });
    const broker = new LifecycleTestKeyBroker({ seed: "task18-response-delivery-replay-broker" });
    const commandId = randomUUID();
    const rootStart = {
      operation: "root-start",
      commandId,
      continuityKey: "task18-response-delivery-replay-continuity",
      idempotencyKey: "task18-response-delivery-replay-idempotency",
    };
    let eventsPath = "";
    try {
      const first = new LifecycleFixtureClient({
        fixturePath: FIXTURE_PATH,
        timeoutMs: 15_000,
        cleanupTimeoutMs: 15_000,
        keyBroker: broker,
      });
      clients.add(first);
      await first.ready();
      const started = await first.start({
        projectRoot,
        vaultRoot,
        clientInstanceId: "task18-response-delivery-replay",
        useParentKeyBroker: true,
      });
      assert.equal(started.type, "started");
      const startedPayload = started.payload as Record<string, unknown>;
      assert.equal(typeof startedPayload.eventsPath, "string");
      eventsPath = startedPayload.eventsPath as string;
      assert.deepEqual(valueOf(await first.fault({
        boundary: "response-delivery",
        point: "after-commit-before-response",
      })), {
        boundary: "response-delivery",
        point: "after-commit-before-response",
        armed: true,
      });
      await assert.rejects(first.mutation(rootStart), /fixture exited before barrier|fixture exited before mutation/i);
      assert.deepEqual(await first.forceCleanup(), { code: 137, signal: null });
      clients.delete(first);

      assert.equal(countRows(eventsPath, "events"), 1);
      assert.equal(countRows(eventsPath, "command_dedup"), 1);
      assert.equal(countRows(eventsPath, "session_authority"), 1);

      const retry = new LifecycleFixtureClient({
        fixturePath: FIXTURE_PATH,
        timeoutMs: 15_000,
        cleanupTimeoutMs: 15_000,
        keyBroker: broker,
      });
      clients.add(retry);
      await retry.ready();
      assert.equal((await retry.start({
        projectRoot,
        vaultRoot,
        clientInstanceId: "task18-response-delivery-replay",
        useParentKeyBroker: true,
      })).type, "started");
      const replay = valueOf(await retry.mutation(rootStart));
      assert.equal(replay.operation, "root-start");
      assert.equal((replay.result as Record<string, unknown>).kind, "success");
      await retry.close();
      clients.delete(retry);

      assert.equal(countRows(eventsPath, "events"), 1);
      assert.equal(countRows(eventsPath, "command_dedup"), 1);
      assert.equal(countRows(eventsPath, "session_authority"), 1);
    } finally {
      broker.shutdown();
    }
  });

  it("replays private current-descriptor delivery through ProjectStoreExecutor and deletes its pending record only after redelivery", async () => {
    const root = mkdtempSync(join(tmpdir(), "task18-private-response-delivery-replay-"));
    roots.push(root);
    const projectRoot = join(root, "project");
    const vaultRoot = join(projectRoot, "memory");
    mkdirSync(vaultRoot, { recursive: true });
    const broker = new LifecycleTestKeyBroker({ seed: "task18-private-response-delivery-replay-broker" });
    const commandId = randomUUID();
    const rootStart = {
      operation: "executor-root-start",
      commandId,
      continuityKey: "task18-private-response-delivery-replay-continuity",
      idempotencyKey: "task18-private-response-delivery-replay-idempotency",
    };
    const retryRootStart = { ...rootStart, requirePendingReplay: true };
    let eventsPath = "";
    try {
      const first = new LifecycleFixtureClient({
        fixturePath: FIXTURE_PATH,
        timeoutMs: 15_000,
        cleanupTimeoutMs: 15_000,
        keyBroker: broker,
      });
      clients.add(first);
      await first.ready();
      const started = await first.start({
        projectRoot,
        vaultRoot,
        clientInstanceId: "task18-private-response-delivery-replay",
        useParentKeyBroker: true,
      });
      if (started.type !== "started") assert.fail(JSON.stringify(started));
      const startedPayload = started.payload as Record<string, unknown>;
      assert.equal(typeof startedPayload.eventsPath, "string");
      eventsPath = startedPayload.eventsPath as string;
      await first.fault({
        boundary: "response-delivery",
        point: "after-commit-before-response",
      });
      await assert.rejects(first.mutation(rootStart), /fixture exited before barrier|fixture exited before mutation/i);
      assert.deepEqual(await first.forceCleanup(), { code: 137, signal: null });
      clients.delete(first);

      assert.equal(countRows(eventsPath, "events"), 1);
      assert.equal(countRows(eventsPath, "command_dedup"), 1);
      const pendingFiles = readdirSync(join(root, "task18-host-private"), {
        recursive: true,
      }).filter((entry) => typeof entry === "string" && entry.endsWith(".json"));
      assert.equal(pendingFiles.length, 1, "the original encrypted pending record must survive response loss");

      const retry = new LifecycleFixtureClient({
        fixturePath: FIXTURE_PATH,
        timeoutMs: 15_000,
        cleanupTimeoutMs: 15_000,
        keyBroker: broker,
      });
      clients.add(retry);
      await retry.ready();
      await retry.start({
        projectRoot,
        vaultRoot,
        clientInstanceId: "task18-private-response-delivery-replay",
        useParentKeyBroker: true,
      });
      const replay = valueOf(await retry.mutation(retryRootStart));
      assert.equal(replay.operation, "root-start");
      assert.equal((replay.result as Record<string, unknown>).kind, "success");
      assert.equal(replay.authorityMaterialDelivered, true);
      assert.equal(replay.resumedPending, true);
      assert.equal(replay.pendingRecordDeleted, true);
      await retry.close();
      clients.delete(retry);

      assert.equal(countRows(eventsPath, "events"), 1);
      assert.equal(countRows(eventsPath, "command_dedup"), 1);
    } finally {
      broker.shutdown();
    }
  });
});
