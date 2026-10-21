import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";
import {
  LifecycleFixtureClient,
  type LifecycleFixtureChildMessage,
} from "./support/lifecycle-fixture-client.js";
import { LifecycleTestKeyBroker } from "./support/lifecycle-test-key-broker.js";

const FIXTURE_PATH = fileURLToPath(new URL("./fixtures/project-store-lifecycle-child.js", import.meta.url));
const clients = new Set<LifecycleFixtureClient>();
const roots: string[] = [];

afterEach(async () => {
  await Promise.all([...clients].map(async (client) => {
    try { await client.dispose(); } catch { await client.forceCleanup(); }
  }));
  clients.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function result(message: LifecycleFixtureChildMessage): Record<string, unknown> {
  assert.equal(message.type, "result");
  assert.ok(message.value === null || typeof message.value === "object");
  return (message.value ?? {}) as Record<string, unknown>;
}

function tableCount(
  eventsPath: string,
  table: "events" | "command_dedup" | "session_authority" | "workflow_instances",
): number {
  const database = new DatabaseSync(eventsPath, { readOnly: true });
  try {
    return (database.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { readonly count: number }).count;
  } finally {
    database.close();
  }
}

describe("Task 18 lifecycle process concurrency", () => {
  it("starts one real root through the parent-owned key broker", async () => {
    const root = mkdtempSync(join(tmpdir(), "task18-root-start-"));
    roots.push(root);
    const projectRoot = join(root, "project");
    const vaultRoot = join(projectRoot, "memory");
    mkdirSync(vaultRoot, { recursive: true });
    const broker = new LifecycleTestKeyBroker({ seed: "task18-parent-owned-key-seed" });
    const client = new LifecycleFixtureClient({
      fixturePath: FIXTURE_PATH,
      timeoutMs: 15_000,
      cleanupTimeoutMs: 15_000,
      keyBroker: broker,
    });
    clients.add(client);
    try {
      await client.ready();
      const started = await client.start({
        projectRoot,
        vaultRoot,
        clientInstanceId: "task18-root-start",
        useParentKeyBroker: true,
      });
      assert.equal(started.type, "started");
      const reply = result(await client.mutation({
        operation: "root-start",
        continuityKey: "task18-root-continuity",
        idempotencyKey: "task18-root-start-idempotency",
      }));
      assert.equal(reply.operation, "root-start");
      assert.equal(reply.nestedContractVersion, null);
      const execution = reply.result as Record<string, unknown>;
      assert.equal(execution.kind, "success");
      const rootStart = execution.publicResult as Record<string, unknown>;
      assert.equal(rootStart.state, "active");
      assert.equal(rootStart.ownerGeneration, "1");
      assert.ok(typeof rootStart.sessionId === "string");
      assert.ok(broker.calls.length > 0);
      assert.ok(client.keyRequestAudit.length > 0);
      assert.ok(client.keyRequestAudit.every((request) => (
        !Object.prototype.hasOwnProperty.call(request, "bytes")
        && !Object.prototype.hasOwnProperty.call(request, "mac")
        && !Object.prototype.hasOwnProperty.call(request, "sealed")
      )));
    } finally {
      try { await client.dispose(); } catch { await client.forceCleanup(); }
      clients.delete(client);
      broker.shutdown();
    }
  });

  it("runs a real connection-bound lifecycle recovery operation inside the forked child", async () => {
    const root = mkdtempSync(join(tmpdir(), "task18-real-lifecycle-"));
    roots.push(root);
    const projectRoot = join(root, "project");
    const vaultRoot = join(projectRoot, "memory");
    mkdirSync(vaultRoot, { recursive: true });
    const client = new LifecycleFixtureClient({
      fixturePath: FIXTURE_PATH,
      timeoutMs: 15_000,
      cleanupTimeoutMs: 15_000,
    });
    clients.add(client);
    await client.ready();
    const started = await client.start({
      projectRoot,
      vaultRoot,
      clientInstanceId: "task18-real-recovery",
    });
    assert.equal(started.type, "started");
    const reply = result(await client.mutation({
      operation: "workflow-recovery",
      workId: "task18-real-recovery-work",
      ownerId: "task18-real-recovery-owner",
      fencingToken: "1",
      dueBefore: "2026-08-17T00:00:00.000Z",
      limit: 10,
    }));
    assert.equal(reply.operation, "workflow-recovery");
    assert.equal(reply.nestedContractVersion, null);
    const recovery = reply.result as Record<string, unknown>;
    assert.equal(recovery.resultVersion, 1);
    assert.equal(recovery.readOnly, true);
    assert.equal(recovery.integrityOk, true);
    await client.close();
    clients.delete(client);
  });

  it("allows exactly one simultaneous root start for a continuity owner", async () => {
    const root = mkdtempSync(join(tmpdir(), "task18-same-continuity-race-"));
    roots.push(root);
    const projectRoot = join(root, "project");
    const vaultRoot = join(projectRoot, "memory");
    mkdirSync(vaultRoot, { recursive: true });
    const broker = new LifecycleTestKeyBroker({ seed: "task18-same-continuity-race-broker" });
    const first = new LifecycleFixtureClient({
      fixturePath: FIXTURE_PATH,
      timeoutMs: 30_000,
      cleanupTimeoutMs: 30_000,
      keyBroker: broker,
    });
    const competing = new LifecycleFixtureClient({
      fixturePath: FIXTURE_PATH,
      timeoutMs: 30_000,
      cleanupTimeoutMs: 30_000,
      keyBroker: broker,
    });
    clients.add(first);
    clients.add(competing);
    try {
      await Promise.all([first.ready(), competing.ready()]);
      const firstStarted = await first.start({
        projectRoot,
        vaultRoot,
        clientInstanceId: "task18-same-continuity-primary-a",
        useParentKeyBroker: true,
      });
      const competingStarted = await competing.start({
        projectRoot,
        vaultRoot,
        clientInstanceId: "task18-same-continuity-primary-b",
        useParentKeyBroker: true,
      });
      assert.equal(firstStarted.type, "started");
      assert.equal(competingStarted.type, "started");
      const eventsPath = (firstStarted.payload as Record<string, unknown>).eventsPath;
      if (typeof eventsPath !== "string") assert.fail("real fixture did not return eventsPath");
      const [firstResult, competingResult] = await Promise.all([
        first.mutation({
          operation: "root-start",
          continuityKey: "task18-same-continuity",
          idempotencyKey: "task18-same-continuity-a",
        }),
        competing.mutation({
          operation: "root-start",
          continuityKey: "task18-same-continuity",
          idempotencyKey: "task18-same-continuity-b",
        }),
      ]);
      const replies = [firstResult, competingResult];
      const successes = replies.filter((reply) => reply.type === "result");
      const conflicts = replies.filter((reply) => reply.type === "error");
      assert.equal(successes.length, 1);
      assert.equal(conflicts.length, 1);
      assert.equal((conflicts[0] as { readonly code: string }).code, "CONTINUITY_CONFLICT");
      const publicResult = (result(successes[0]!).result as Record<string, unknown>).publicResult as Record<string, unknown>;
      assert.equal(publicResult.state, "active");
      assert.equal(publicResult.ownerGeneration, "1");
      assert.equal(tableCount(eventsPath, "events"), 1);
      assert.equal(tableCount(eventsPath, "command_dedup"), 1);
      assert.equal(tableCount(eventsPath, "session_authority"), 1);
      await Promise.all([first.close(), competing.close()]);
      clients.delete(first);
      clients.delete(competing);
    } finally {
      broker.shutdown();
    }
  });

  it("keeps simultaneous unrelated roots and an identical-continuity second project isolated", async () => {
    const root = mkdtempSync(join(tmpdir(), "task18-root-project-isolation-"));
    roots.push(root);
    const firstProjectRoot = join(root, "project-a");
    const firstVaultRoot = join(firstProjectRoot, "memory");
    const secondProjectRoot = join(root, "project-b");
    const secondVaultRoot = join(secondProjectRoot, "memory");
    mkdirSync(firstVaultRoot, { recursive: true });
    mkdirSync(secondVaultRoot, { recursive: true });
    const broker = new LifecycleTestKeyBroker({ seed: "task18-root-project-isolation-broker" });
    const first = new LifecycleFixtureClient({
      fixturePath: FIXTURE_PATH,
      timeoutMs: 30_000,
      cleanupTimeoutMs: 30_000,
      keyBroker: broker,
    });
    const unrelated = new LifecycleFixtureClient({
      fixturePath: FIXTURE_PATH,
      timeoutMs: 30_000,
      cleanupTimeoutMs: 30_000,
      keyBroker: broker,
    });
    const secondProject = new LifecycleFixtureClient({
      fixturePath: FIXTURE_PATH,
      timeoutMs: 30_000,
      cleanupTimeoutMs: 30_000,
      keyBroker: broker,
    });
    clients.add(first);
    clients.add(unrelated);
    clients.add(secondProject);
    try {
      await Promise.all([first.ready(), unrelated.ready(), secondProject.ready()]);
      const firstStarted = await first.start({
        projectRoot: firstProjectRoot,
        vaultRoot: firstVaultRoot,
        clientInstanceId: "task18-isolated-primary-a",
        useParentKeyBroker: true,
      });
      const unrelatedStarted = await unrelated.start({
        projectRoot: firstProjectRoot,
        vaultRoot: firstVaultRoot,
        clientInstanceId: "task18-isolated-primary-b",
        useParentKeyBroker: true,
      });
      const secondStarted = await secondProject.start({
        projectRoot: secondProjectRoot,
        vaultRoot: secondVaultRoot,
        clientInstanceId: "task18-isolated-second-project",
        useParentKeyBroker: true,
      });
      assert.equal(firstStarted.type, "started");
      assert.equal(unrelatedStarted.type, "started");
      assert.equal(secondStarted.type, "started");
      const firstEventsPath = (firstStarted.payload as Record<string, unknown>).eventsPath;
      const secondEventsPath = (secondStarted.payload as Record<string, unknown>).eventsPath;
      if (typeof firstEventsPath !== "string" || typeof secondEventsPath !== "string") {
        assert.fail("real fixture did not return events paths");
      }
      const continuityKey = "task18-identical-continuity";
      const [firstReply, unrelatedReply, secondReply] = await Promise.all([
        first.mutation({
          operation: "root-start",
          continuityKey,
          idempotencyKey: "task18-isolated-root-a",
        }),
        unrelated.mutation({
          operation: "root-start",
          continuityKey: "task18-unrelated-root",
          idempotencyKey: "task18-isolated-root-b",
        }),
        secondProject.mutation({
          operation: "root-start",
          continuityKey,
          idempotencyKey: "task18-isolated-second-project",
        }),
      ]);
      const firstPublic = (result(firstReply).result as Record<string, unknown>).publicResult as Record<string, unknown>;
      const unrelatedPublic = (result(unrelatedReply).result as Record<string, unknown>).publicResult as Record<string, unknown>;
      const secondPublic = (result(secondReply).result as Record<string, unknown>).publicResult as Record<string, unknown>;
      assert.notEqual(firstPublic.sessionId, unrelatedPublic.sessionId);
      assert.equal(firstPublic.continuityKey, continuityKey);
      assert.equal(secondPublic.continuityKey, continuityKey);
      assert.notEqual(
        ((firstPublic.project as Record<string, unknown>).projectId),
        ((secondPublic.project as Record<string, unknown>).projectId),
      );
      assert.equal(tableCount(firstEventsPath, "events"), 2);
      assert.equal(tableCount(firstEventsPath, "command_dedup"), 2);
      assert.equal(tableCount(firstEventsPath, "session_authority"), 2);
      assert.equal(tableCount(secondEventsPath, "events"), 1);
      assert.equal(tableCount(secondEventsPath, "command_dedup"), 1);
      assert.equal(tableCount(secondEventsPath, "session_authority"), 1);
      await Promise.all([first.close(), unrelated.close(), secondProject.close()]);
      clients.delete(first);
      clients.delete(unrelated);
      clients.delete(secondProject);
    } finally {
      broker.shutdown();
    }
  });

  it("keeps real Git linked-worktree roots separate while they share only Git-common project storage", async () => {
    const root = mkdtempSync(join(tmpdir(), "task18-linked-workspaces-"));
    roots.push(root);
    const firstProjectRoot = join(root, "worktree-a");
    const linkedProjectRoot = join(root, "worktree-b");
    execFileSync("git", ["init", "--initial-branch=main", firstProjectRoot], { stdio: "ignore" });
    execFileSync("git", ["-C", firstProjectRoot, "config", "user.email", "task18@example.invalid"], { stdio: "ignore" });
    execFileSync("git", ["-C", firstProjectRoot, "config", "user.name", "Task 18 Fixture"], { stdio: "ignore" });
    writeFileSync(join(firstProjectRoot, "README.md"), "# task18 linked worktree fixture\n", "utf8");
    execFileSync("git", ["-C", firstProjectRoot, "add", "README.md"], { stdio: "ignore" });
    execFileSync("git", ["-C", firstProjectRoot, "commit", "-m", "task18 fixture"], { stdio: "ignore" });
    execFileSync("git", ["-C", firstProjectRoot, "worktree", "add", "-b", "task18-linked", linkedProjectRoot], { stdio: "ignore" });
    const firstVaultRoot = join(firstProjectRoot, "memory");
    const linkedVaultRoot = join(linkedProjectRoot, "memory");
    mkdirSync(firstVaultRoot, { recursive: true });
    mkdirSync(linkedVaultRoot, { recursive: true });
    const broker = new LifecycleTestKeyBroker({ seed: "task18-linked-workspaces-broker" });
    const first = new LifecycleFixtureClient({
      fixturePath: FIXTURE_PATH,
      timeoutMs: 30_000,
      cleanupTimeoutMs: 30_000,
      keyBroker: broker,
    });
    const linked = new LifecycleFixtureClient({
      fixturePath: FIXTURE_PATH,
      timeoutMs: 30_000,
      cleanupTimeoutMs: 30_000,
      keyBroker: broker,
    });
    clients.add(first);
    clients.add(linked);
    try {
      await Promise.all([first.ready(), linked.ready()]);
      const firstStarted = await first.start({
        projectRoot: firstProjectRoot,
        vaultRoot: firstVaultRoot,
        clientInstanceId: "task18-linked-worktree-a",
        useParentKeyBroker: true,
      });
      if (firstStarted.type !== "started") assert.fail(JSON.stringify(firstStarted));
      const descriptorDirectory = join(firstVaultRoot, ".memory-mcp");
      mkdirSync(join(linkedVaultRoot, ".memory-mcp"), { recursive: true });
      copyFileSync(
        join(descriptorDirectory, "project-identity.json"),
        join(linkedVaultRoot, ".memory-mcp", "project-identity.json"),
      );
      const linkedStarted = await linked.start({
        projectRoot: linkedProjectRoot,
        vaultRoot: linkedVaultRoot,
        clientInstanceId: "task18-linked-worktree-b",
        useParentKeyBroker: true,
      });
      if (linkedStarted.type !== "started") assert.fail(JSON.stringify(linkedStarted));
      const eventsPath = (firstStarted.payload as Record<string, unknown>).eventsPath;
      if (typeof eventsPath !== "string") assert.fail("first linked fixture did not return an events path");
      assert.equal((linkedStarted.payload as Record<string, unknown>).eventsPath, eventsPath);
      const continuityKey = "task18-linked-workspace-continuity";
      const firstResult = await first.mutation({
        operation: "root-start",
        continuityKey,
        idempotencyKey: "task18-linked-worktree-a-root",
      });
      const linkedResult = await linked.mutation({
        operation: "root-start",
        continuityKey,
        idempotencyKey: "task18-linked-worktree-b-root",
      });
      if (firstResult.type !== "result") assert.fail(JSON.stringify(firstResult));
      if (linkedResult.type !== "result") assert.fail(JSON.stringify(linkedResult));
      const firstPublic = (result(firstResult).result as Record<string, unknown>).publicResult as Record<string, unknown>;
      const linkedPublic = (result(linkedResult).result as Record<string, unknown>).publicResult as Record<string, unknown>;
      const firstProject = firstPublic.project as Record<string, unknown>;
      const linkedProject = linkedPublic.project as Record<string, unknown>;
      assert.equal(firstProject.projectId, linkedProject.projectId);
      assert.equal(firstProject.storeId, linkedProject.storeId);
      assert.notEqual(firstProject.workspaceId, linkedProject.workspaceId);
      assert.notEqual(firstPublic.sessionId, linkedPublic.sessionId);
      assert.equal(tableCount(eventsPath, "events"), 2);
      assert.equal(tableCount(eventsPath, "session_authority"), 2);
      await Promise.all([first.close(), linked.close()]);
      clients.delete(first);
      clients.delete(linked);
    } finally {
      broker.shutdown();
    }
  });

  it("forks thirty-two real child sessions without changing root ownership", async () => {
    const root = mkdtempSync(join(tmpdir(), "task18-child-ownership-"));
    roots.push(root);
    const projectRoot = join(root, "project");
    const vaultRoot = join(projectRoot, "memory");
    mkdirSync(vaultRoot, { recursive: true });
    const broker = new LifecycleTestKeyBroker({ seed: "task18-child-ownership-broker" });
    const client = new LifecycleFixtureClient({
      fixturePath: FIXTURE_PATH,
      timeoutMs: 30_000,
      cleanupTimeoutMs: 30_000,
      keyBroker: broker,
    });
    clients.add(client);
    try {
      await client.ready();
      const started = await client.start({
        projectRoot,
        vaultRoot,
        clientInstanceId: "task18-child-ownership-root",
        useParentKeyBroker: true,
      });
      assert.equal(started.type, "started");
      const eventsPath = (started.payload as Record<string, unknown>).eventsPath;
      if (typeof eventsPath !== "string") assert.fail("real fixture did not return eventsPath");
      const rootStarted = result(await client.mutation({
        operation: "root-start",
        continuityKey: "task18-child-ownership",
        idempotencyKey: "task18-child-ownership-root-start",
      }));
      const rootPublic = ((rootStarted.result as Record<string, unknown>).publicResult) as Record<string, unknown>;
      const forkMessage = await client.mutation({ operation: "fork-children", count: 32 });
      assert.equal(forkMessage.type, "result", JSON.stringify(forkMessage));
      const forks = result(forkMessage);
      assert.equal(forks.operation, "fork-children");
      assert.equal(forks.childCount, 32);
      assert.equal(forks.parentSessionId, rootPublic.sessionId);
      assert.equal(forks.rootOwnerGeneration, "1");
      await client.close();
      clients.delete(client);

      assert.equal(tableCount(eventsPath, "events"), 33);
      assert.equal(tableCount(eventsPath, "command_dedup"), 33);
      assert.equal(tableCount(eventsPath, "session_authority"), 33);
    } finally {
      broker.shutdown();
    }
  });

  it("runs an untrusted child report, proposal, and root-only completion without exporting authority material", async () => {
    const root = mkdtempSync(join(tmpdir(), "task18-child-direct-workflow-"));
    roots.push(root);
    const projectRoot = join(root, "project");
    const vaultRoot = join(projectRoot, "memory");
    mkdirSync(vaultRoot, { recursive: true });
    const broker = new LifecycleTestKeyBroker({ seed: "task18-child-direct-workflow-broker" });
    const client = new LifecycleFixtureClient({
      fixturePath: FIXTURE_PATH,
      timeoutMs: 30_000,
      cleanupTimeoutMs: 30_000,
      keyBroker: broker,
    });
    clients.add(client);
    try {
      await client.ready();
      const started = await client.start({
        projectRoot,
        vaultRoot,
        clientInstanceId: "task18-child-direct-workflow-root",
        useParentKeyBroker: true,
      });
      assert.equal(started.type, "started");
      const eventsPath = (started.payload as Record<string, unknown>).eventsPath;
      if (typeof eventsPath !== "string") assert.fail("real fixture did not return eventsPath");
      const startedRoot = result(await client.mutation({
        operation: "root-start",
        continuityKey: "task18-child-direct-workflow",
        idempotencyKey: "task18-child-direct-workflow-root-start",
      }));
      const rootPublic = (startedRoot.result as Record<string, unknown>).publicResult as Record<string, unknown>;
      const workflow = result(await client.mutation({ operation: "child-workflow" }));
      assert.equal(workflow.operation, "child-workflow");
      assert.equal(workflow.parentSessionId, rootPublic.sessionId);
      assert.equal(workflow.rootOwnerGeneration, "1");
      assert.equal(workflow.rootState, "active");
      assert.equal(workflow.childState, "completed");
      assert.equal(workflow.reported, true);
      assert.equal(workflow.proposed, true);
      assert.equal(workflow.completed, true);
      assert.equal(JSON.stringify(workflow).includes("authorityMaterial"), false);
      assert.equal(JSON.stringify(workflow).includes("resumeToken"), false);
      await client.close();
      clients.delete(client);

      assert.equal(tableCount(eventsPath, "events"), 5);
      assert.equal(tableCount(eventsPath, "command_dedup"), 5);
      assert.equal(tableCount(eventsPath, "session_authority"), 2);
    } finally {
      broker.shutdown();
    }
  });

  it("uses the current root proof for one real session-end request and exact replay", async () => {
    const root = mkdtempSync(join(tmpdir(), "task18-session-end-request-"));
    roots.push(root);
    const projectRoot = join(root, "project");
    const vaultRoot = join(projectRoot, "memory");
    mkdirSync(vaultRoot, { recursive: true });
    const broker = new LifecycleTestKeyBroker({ seed: "task18-session-end-request-broker" });
    const client = new LifecycleFixtureClient({
      fixturePath: FIXTURE_PATH,
      timeoutMs: 30_000,
      cleanupTimeoutMs: 30_000,
      keyBroker: broker,
    });
    clients.add(client);
    try {
      await client.ready();
      const started = await client.start({
        projectRoot,
        vaultRoot,
        clientInstanceId: "task18-session-end-request-root",
        useParentKeyBroker: true,
      });
      assert.equal(started.type, "started");
      const eventsPath = (started.payload as Record<string, unknown>).eventsPath;
      if (typeof eventsPath !== "string") assert.fail("real fixture did not return eventsPath");
      const startedRoot = result(await client.mutation({
        operation: "root-start",
        continuityKey: "task18-session-end-request",
        idempotencyKey: "task18-session-end-request-root-start",
      }));
      const rootPublic = (startedRoot.result as Record<string, unknown>).publicResult as Record<string, unknown>;
      const sessionId = rootPublic.sessionId;
      if (typeof sessionId !== "string") assert.fail("root start did not return a session id");
      const checkpoint = result(await client.mutation({ operation: "record-root-checkpoint" }));
      assert.equal(checkpoint.operation, "record-root-checkpoint");
      const request = {
        operation: "request-session-end",
        commandId: "42e9d26b-15d8-42c7-9da0-937bf2c6ce18",
        idempotencyKey: "task18-session-end-request/1",
        proofNonce: "ec1cb1ff-8ca5-4c59-89d5-8f899c3927d6",
      };
      const firstMessage = await client.mutation(request);
      assert.equal(firstMessage.type, "result", JSON.stringify(firstMessage));
      const first = result(firstMessage);
      const replayMessage = await client.mutation(request);
      assert.equal(replayMessage.type, "result", JSON.stringify(replayMessage));
      const replay = result(replayMessage);
      assert.deepEqual(replay, first);
      assert.equal(first.operation, "request-session-end");
      const execution = first.result as Record<string, unknown>;
      assert.equal(execution.kind, "success");
      const status = execution.publicResult as Record<string, unknown>;
      assert.equal(status.resultVersion, 2);
      assert.equal(status.sessionId, sessionId);
      assert.equal(status.workflowGeneration, 1);
      assert.equal(status.phase, "requested");
      assert.equal(JSON.stringify(first).includes("authorityMaterial"), false);
      assert.equal(JSON.stringify(first).includes("resumeToken"), false);
      await client.close();
      clients.delete(client);

      assert.equal(tableCount(eventsPath, "events"), 3);
      assert.equal(tableCount(eventsPath, "command_dedup"), 3);
      assert.equal(tableCount(eventsPath, "workflow_instances"), 1);
      const database = new DatabaseSync(eventsPath, { readOnly: true });
      try {
        const rootRow = database.prepare(`
          SELECT semantic_state AS state
          FROM session_authority
          WHERE session_id = $sessionId
        `).get({ $sessionId: sessionId }) as { readonly state: string };
        assert.equal(rootRow.state, "ending");
      } finally {
        database.close();
      }
    } finally {
      broker.shutdown();
    }
  });

  it("keeps thirty-two real process observers from changing one root or its child authority", async () => {
    const root = mkdtempSync(join(tmpdir(), "task18-process-isolation-"));
    roots.push(root);
    const projectRoot = join(root, "project");
    const vaultRoot = join(projectRoot, "memory");
    mkdirSync(vaultRoot, { recursive: true });
    const broker = new LifecycleTestKeyBroker({ seed: "task18-process-isolation-broker" });
    const primary = new LifecycleFixtureClient({
      fixturePath: FIXTURE_PATH,
      timeoutMs: 45_000,
      cleanupTimeoutMs: 45_000,
      keyBroker: broker,
    });
    clients.add(primary);
    const observers: LifecycleFixtureClient[] = [];
    try {
      await primary.ready();
      const started = await primary.start({
        projectRoot,
        vaultRoot,
        clientInstanceId: "task18-process-isolation-root",
        useParentKeyBroker: true,
      });
      assert.equal(started.type, "started");
      const eventsPath = (started.payload as Record<string, unknown>).eventsPath;
      if (typeof eventsPath !== "string") assert.fail("real fixture did not return eventsPath");
      const rootStarted = result(await primary.mutation({
        operation: "root-start",
        continuityKey: "task18-process-isolation",
        idempotencyKey: "task18-process-isolation-root-start",
      }));
      const rootPublic = ((rootStarted.result as Record<string, unknown>).publicResult) as Record<string, unknown>;
      const rootSessionId = rootPublic.sessionId;
      if (typeof rootSessionId !== "string") assert.fail("root start did not return a session id");
      assert.equal((result(await primary.mutation({ operation: "fork-children", count: 32 }))).childCount, 32);
      await primary.close();
      clients.delete(primary);

      for (let batchStart = 0; batchStart < 32; batchStart += 4) {
        const batch = Array.from({ length: 4 }, (_, offset) => {
          const index = batchStart + offset;
          const observer = new LifecycleFixtureClient({
            fixturePath: FIXTURE_PATH,
            timeoutMs: 45_000,
            cleanupTimeoutMs: 45_000,
          });
          observers.push(observer);
          clients.add(observer);
          return { index, observer };
        });
        await Promise.all(batch.map(async ({ index, observer }) => {
          await observer.ready();
          const observerStarted = await observer.start({
            projectRoot,
            vaultRoot,
            clientInstanceId: `task18-process-observer-${index}`,
          });
          assert.equal(observerStarted.type, "started", JSON.stringify(observerStarted));
        }));
      }

      const responses = await Promise.all(observers.map(async (observer, index) => result(await observer.mutation({
        operation: "workflow-recovery",
        workId: `task18-process-observer-work-${index}`,
        ownerId: `task18-process-observer-${index}`,
        fencingToken: "1",
        dueBefore: "2026-08-17T00:00:00.000Z",
        limit: 10,
      }))));
      await Promise.all(observers.map(async (observer) => {
        await observer.close();
        clients.delete(observer);
      }));

      assert.equal(responses.length, 32);
      assert.ok(responses.every((response) => {
        const recovery = response.result as Record<string, unknown>;
        return recovery.readOnly === true && recovery.integrityOk === true;
      }));
      assert.equal(tableCount(eventsPath, "events"), 33);
      assert.equal(tableCount(eventsPath, "command_dedup"), 33);
      assert.equal(tableCount(eventsPath, "session_authority"), 33);
      const database = new DatabaseSync(eventsPath, { readOnly: true });
      try {
        const rootRow = database.prepare(`
          SELECT owner_generation AS ownerGeneration, semantic_state AS state
          FROM session_authority
          WHERE session_id = $sessionId
        `).get({ $sessionId: rootSessionId }) as { readonly ownerGeneration: number | bigint; readonly state: string };
        assert.equal(String(rootRow.ownerGeneration), "1");
        assert.equal(rootRow.state, "active");
      } finally {
        database.close();
      }
    } finally {
      await Promise.all(observers.map(async (observer) => {
        try { await observer.dispose(); } catch { await observer.forceCleanup(); }
      }));
      broker.shutdown();
    }
  });
});
