import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { LifecycleFixtureClient } from "./support/lifecycle-fixture-client.js";
import { LifecycleTestKeyBroker } from "./support/lifecycle-test-key-broker.js";

const FIXTURE_PATH = fileURLToPath(new URL("./fixtures/project-store-lifecycle-child.js", import.meta.url));

function result(message: { readonly type: string; readonly value?: unknown }): Record<string, unknown> {
  assert.equal(message.type, "result");
  assert.ok(message.value !== null && typeof message.value === "object");
  return message.value as Record<string, unknown>;
}

function tableCount(eventsPath: string, table: "events" | "command_dedup" | "session_authority"): number {
  const database = new DatabaseSync(eventsPath, { readOnly: true });
  try {
    return (database.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { readonly count: number }).count;
  } finally {
    database.close();
  }
}

function currentRootCount(eventsPath: string): number {
  const database = new DatabaseSync(eventsPath, { readOnly: true });
  try {
    return (database.prepare(`
      SELECT count(*) AS count
      FROM session_authority
      WHERE session_kind = 'root'
        AND semantic_state = 'active'
        AND owner_generation = 1
        AND terminal_event_position IS NULL
    `).get() as { readonly count: number }).count;
  } finally {
    database.close();
  }
}

describe("Task 18 serialized lifecycle stress", () => {
  it("runs ten deterministic seeds with a real root, thirty-two child effects, and an independent observer", {
    skip: process.env.MEMORY_LIFECYCLE_STRESS !== "1",
  }, async () => {
    for (let seed = 0; seed < 10; seed += 1) {
      const root = mkdtempSync(join(tmpdir(), `task18-stress-${seed}-`));
      const projectRoot = join(root, "project");
      const vaultRoot = join(projectRoot, "memory");
      mkdirSync(vaultRoot, { recursive: true });
      const broker = new LifecycleTestKeyBroker({ seed: `task18-stress-broker-${seed}` });
      const primary = new LifecycleFixtureClient({
        fixturePath: FIXTURE_PATH,
        timeoutMs: 45_000,
        cleanupTimeoutMs: 45_000,
        keyBroker: broker,
      });
      let observer: LifecycleFixtureClient | undefined;
      try {
        await primary.ready();
        const started = await primary.start({
          projectRoot,
          vaultRoot,
          clientInstanceId: `task18-stress-root-${seed}`,
          useParentKeyBroker: true,
        });
        assert.equal(started.type, "started", `seed ${seed}`);
        const eventsPath = (started.payload as Record<string, unknown>).eventsPath;
        if (typeof eventsPath !== "string") assert.fail(`seed ${seed} missing events path`);
        const rootStart = result(await primary.mutation({
          operation: "root-start",
          continuityKey: `task18-stress-continuity-${seed}`,
          idempotencyKey: `task18-stress-root-start-${seed}`,
        }));
        const rootPublic = (rootStart.result as Record<string, unknown>).publicResult as Record<string, unknown>;
        assert.equal(rootPublic.state, "active", `seed ${seed}`);
        const startedScope = started.payload as Record<string, unknown>;
        const projectId = startedScope.projectId;
        const storeId = startedScope.storeId;
        if (typeof projectId !== "string" || typeof storeId !== "string") {
          assert.fail(`seed ${seed} missing lifecycle key scope`);
        }
        broker.rotate({ projectId, storeId }, "root-session-handle");
        const childWorkflow = result(await primary.mutation({ operation: "child-workflow" }));
        assert.equal(childWorkflow.childState, "completed", `seed ${seed}`);
        assert.equal(childWorkflow.rootOwnerGeneration, "1", `seed ${seed}`);
        const forks = result(await primary.mutation({ operation: "fork-children", count: 32 }));
        assert.equal(forks.childCount, 32, `seed ${seed}`);
        assert.equal(forks.parentSessionId, rootPublic.sessionId, `seed ${seed}`);
        await primary.close();

        observer = new LifecycleFixtureClient({
          fixturePath: FIXTURE_PATH,
          timeoutMs: 45_000,
          cleanupTimeoutMs: 45_000,
        });
        await observer.ready();
        assert.equal((await observer.start({
          projectRoot,
          vaultRoot,
          clientInstanceId: `task18-stress-observer-${seed}`,
        })).type, "started", `seed ${seed}`);
        const recovery = result(await observer.mutation({
          operation: "workflow-recovery",
          workId: `task18-stress-recovery-${seed}`,
          ownerId: `task18-stress-observer-${seed}`,
          fencingToken: "1",
          dueBefore: "2026-08-17T00:00:00.000Z",
          limit: 10,
        }));
        assert.equal((recovery.result as Record<string, unknown>).integrityOk, true, `seed ${seed}`);
        await observer.close();
        observer = undefined;

        assert.equal(tableCount(eventsPath, "events"), 37, `seed ${seed}`);
        assert.equal(tableCount(eventsPath, "command_dedup"), 37, `seed ${seed}`);
        assert.equal(tableCount(eventsPath, "session_authority"), 34, `seed ${seed}`);
        assert.equal(currentRootCount(eventsPath), 1, `seed ${seed}`);
      } finally {
        if (observer !== undefined) {
          try { await observer.dispose(); } catch { await observer.forceCleanup(); }
        }
        try { await primary.dispose(); } catch { await primary.forceCleanup(); }
        broker.shutdown();
        assert.equal(broker.liveKeyMaterialCount, 0, `seed ${seed}`);
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
});
