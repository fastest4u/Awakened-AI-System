import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import { Worker } from "node:worker_threads";
import type { ProjectContext } from "../src/orchestrator/identity/contracts.js";
import {
  ProjectStoreUpgradePhaseRunner,
  type UpgradePhaseWorkerLike,
} from "../src/orchestrator/runtime/project-store-upgrade-phase-runner.js";
import { PROJECT_MEMORY_APPLICATION_ID } from "../src/orchestrator/runtime/runtime-capabilities.js";
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";
import { migrationChecksum } from "../src/orchestrator/storage/migration-runner.js";
import { eventCoreMigration } from "../src/orchestrator/storage/migrations/0001-event-core.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const VAULT_ID = "22222222-2222-4222-8222-222222222222";
const STORE_ID = "33333333-3333-4333-8333-333333333333";
const NOW = "2026-07-16T00:00:00.000Z";

const CONTEXT = {
  binding: {
    projectId: PROJECT_ID,
    vaultId: VAULT_ID,
    storeId: STORE_ID,
    generation: 1,
    contextFingerprint: "a".repeat(64),
    projectBindingId: "phase-runner-binding",
    source: "explicit-cli",
    projectRoot: "C:\\project",
    vaultRoot: "C:\\project\\memory",
    descriptorPath: "C:\\project\\memory\\.memory-mcp\\project-identity.json",
    storeRoute: { kind: "vault-local" },
    workspaceId: "phase-runner-workspace",
    workspace: {
      kind: "non-git",
      workspaceRoot: "C:\\project",
      workspaceId: "phase-runner-workspace",
    },
    clientNamespace: "phase-runner-tests",
    clientInstanceId: "phase-runner-client",
    actorRole: "maintenance",
    establishedAt: "2026-07-16T00:00:00.000Z",
  },
  workspace: {
    kind: "non-git",
    workspaceRoot: "C:\\project",
    workspaceId: "phase-runner-workspace",
  },
  checkedAt: "2026-07-16T00:00:00.000Z",
} as unknown as ProjectContext;

class FakeWorker extends EventEmitter implements UpgradePhaseWorkerLike {
  terminateCalls = 0;

  async terminate(): Promise<number> {
    this.terminateCalls += 1;
    return 1;
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class RejectingTerminationWorker extends FakeWorker {
  override async terminate(): Promise<number> {
    this.terminateCalls += 1;
    throw new Error("termination cleanup failed");
  }
}

class DeferredTerminationWorker extends FakeWorker {
  readonly termination = deferred<number>();

  override terminate(): Promise<number> {
    this.terminateCalls += 1;
    return this.termination.promise;
  }
}

async function outcomeByNextTurn(promise: Promise<unknown>): Promise<string> {
  return Promise.race([
    promise.then(
      () => "resolved",
      (error: unknown) => error instanceof Error && "code" in error
        ? String((error as Error & { code: unknown }).code)
        : String(error),
    ),
    new Promise<string>((resolve) => setImmediate(() => resolve("pending"))),
  ]);
}

function createBundledUpgradeFixture(): {
  readonly root: string;
  readonly eventsPath: string;
  readonly binding: Readonly<Record<string, unknown>>;
} {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "phase-upgrade-v1-")));
  const projectRoot = join(root, "project");
  const vaultRoot = join(projectRoot, "memory");
  const storeRoot = join(vaultRoot, ".memory-mcp", "v2");
  const descriptorPath = join(vaultRoot, ".memory-mcp", "project-identity.json");
  const eventsPath = join(storeRoot, "events.sqlite");
  const storeManifestPath = join(storeRoot, "store-manifest.json");
  const projectionManifestPath = join(storeRoot, "projection-manifest.json");
  mkdirSync(storeRoot, { recursive: true });
  writeFileSync(descriptorPath, `${JSON.stringify({
    schemaVersion: 1,
    projectId: PROJECT_ID,
    vaultId: VAULT_ID,
    createdAt: NOW,
  }, null, 2)}\n`, "utf8");
  writeFileSync(storeManifestPath, `${JSON.stringify({
    schemaVersion: 1,
    storeId: STORE_ID,
    projectId: PROJECT_ID,
    vaultId: VAULT_ID,
    createdAt: NOW,
    lastIntegrity: { status: "never" },
  }, null, 2)}\n`, "utf8");
  const database = new DatabaseSync(eventsPath);
  try {
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA application_id = ${PROJECT_MEMORY_APPLICATION_ID};
    `);
    database.exec(eventCoreMigration.sql);
    database.prepare(`
      INSERT INTO schema_migrations(version, name, checksum, applied_at)
      VALUES (1, $name, $checksum, $now)
    `).run({
      $name: eventCoreMigration.name,
      $checksum: migrationChecksum(eventCoreMigration),
      $now: NOW,
    });
    database.prepare(`
      INSERT INTO project_meta(
        singleton, project_id, vault_id, store_id, schema_version, created_at
      ) VALUES (1, $projectId, $vaultId, $storeId, 1, $now)
    `).run({
      $projectId: PROJECT_ID,
      $vaultId: VAULT_ID,
      $storeId: STORE_ID,
      $now: NOW,
    });
    database.exec(`
      INSERT INTO maintenance_state(
        singleton, epoch, mode, owner_id, fencing_token,
        lease_expires_at, requested_at
      ) VALUES (1, 0, 'idle', NULL, 0, NULL, NULL)
    `);
  } finally {
    database.close();
  }
  const storeRoute = {
    kind: "vault-local",
    storeRoot,
    eventsPath,
    storeManifestPath,
    projectionManifestPath,
  };
  const workspace = {
    kind: "non-git",
    workspaceRoot: projectRoot,
    workspaceId: "phase-runner-workspace",
  };
  const fingerprintMaterial = {
    generation: 1,
    source: "explicit-cli",
    projectId: PROJECT_ID,
    vaultId: VAULT_ID,
    storeId: STORE_ID,
    workspaceId: workspace.workspaceId,
    projectRoot,
    vaultRoot,
    descriptorPath,
    storeRoute,
    workspace,
    clientNamespace: "phase-runner-tests",
    clientInstanceId: "phase-runner-client",
    actorRole: "maintenance",
  };
  const contextFingerprint = createHash("sha256")
    .update(
      `project-memory/project-context/v1\n${canonicalJson(fingerprintMaterial)}`,
      "utf8",
    )
    .digest("hex");
  return {
    root,
    eventsPath,
    binding: {
      projectId: PROJECT_ID,
      vaultId: VAULT_ID,
      storeId: STORE_ID,
      bindingGeneration: 1,
      contextFingerprint,
      projectBindingId: "44444444-4444-4444-8444-444444444444",
      source: "explicit-cli",
      projectRoot,
      vaultRoot,
      descriptorPath,
      storeRoute,
      workspaceId: workspace.workspaceId,
      workspace,
      clientNamespace: fingerprintMaterial.clientNamespace,
      clientInstanceId: fingerprintMaterial.clientInstanceId,
      actorRole: "maintenance",
      establishedAt: NOW,
      checkedAt: NOW,
      branchScopeId: null,
    },
  };
}

it("bundled upgrade applies 2 3 4", async () => {
  const fixture = createBundledUpgradeFixture();
  const worker = new Worker(
    new URL("../src/workers/project-store.worker.js", import.meta.url),
    { workerData: { role: "upgrade", binding: fixture.binding } },
  );
  const operationId = "phase-runner-upgrade";
  const phases: string[] = [];
  try {
    const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("bundled upgrade timed out")),
        30_000,
      );
      worker.on("message", (value: unknown) => {
        if (typeof value !== "object" || value === null) {
          clearTimeout(timeout);
          reject(new Error("invalid bundled worker response"));
          return;
        }
        const message = value as Record<string, unknown>;
        if (message.type === "upgrade-quiesce-required") {
          assert.equal(message.operationId, operationId);
          phases.push("quiesce-required");
          worker.postMessage({
            type: "upgrade-quiesce-complete",
            operationId,
          });
          phases.push("quiesce-complete");
          return;
        }
        if (message.id === operationId) {
          clearTimeout(timeout);
          phases.push("result");
          resolve(message);
        }
      });
      worker.once("messageerror", reject);
      worker.once("error", reject);
      worker.postMessage({ id: operationId, type: "upgrade-apply" });
    });
    assert.equal(response.ok, true);
    const result = response.data as {
      readonly appliedVersions: readonly number[];
      readonly integrity: { readonly ok: boolean };
    };
    assert.deepEqual(result.appliedVersions, [2, 3, 4, 5]);
    assert.equal(result.integrity.ok, true);
    assert.deepEqual(phases, ["quiesce-required", "quiesce-complete", "result"]);

    const database = new DatabaseSync(fixture.eventsPath, { readOnly: true });
    try {
      assert.deepEqual(
        database.prepare("SELECT version FROM schema_migrations ORDER BY version")
          .all().map((row) => Number(row.version)),
        [1, 2, 3, 4, 5],
      );
      assert.equal(
        Number(database.prepare(`
          SELECT schema_version FROM project_meta WHERE singleton = 1
        `).get()?.schema_version),
        5,
      );
    } finally {
      database.close();
    }
    const manifest = JSON.parse(readFileSync(
      join(fixture.root, "project", "memory", ".memory-mcp", "v2", "store-manifest.json"),
      "utf8",
    )) as { lastIntegrity?: { status?: unknown } };
    assert.equal(manifest.lastIntegrity?.status, "passed");
  } finally {
    await worker.terminate().catch(() => undefined);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

it("settles a failure response when termination completes without an exit event", async () => {
  const worker = new FakeWorker();
  const runner = new ProjectStoreUpgradePhaseRunner({
    workerUrl: new URL("file:///fake-upgrade-phase-worker.js"),
    workerFactory: () => worker,
  });
  const phase = runner.fullIntegrity(CONTEXT, new AbortController().signal);

  worker.emit("message", {
    ok: false,
    error: { code: "STORE_INTEGRITY_FAILED" },
  });

  assert.equal(await outcomeByNextTurn(phase), "STORE_INTEGRITY_FAILED");
  assert.equal(worker.terminateCalls, 1);
});

it("preserves a protocol error when termination rejects without an exit event", async () => {
  const worker = new RejectingTerminationWorker();
  const runner = new ProjectStoreUpgradePhaseRunner({
    workerUrl: new URL("file:///fake-upgrade-phase-worker.js"),
    workerFactory: () => worker,
  });
  const phase = runner.fullIntegrity(CONTEXT, new AbortController().signal);

  worker.emit("messageerror", new Error("malformed clone"));

  assert.equal(await outcomeByNextTurn(phase), "WORKER_PROTOCOL_ERROR");
  assert.equal(worker.terminateCalls, 1);
});

it("settles races once with the first error and contains late termination rejection", async () => {
  const worker = new DeferredTerminationWorker();
  const controller = new AbortController();
  const runner = new ProjectStoreUpgradePhaseRunner({
    workerUrl: new URL("file:///fake-upgrade-phase-worker.js"),
    workerFactory: () => worker,
  });
  let settlements = 0;
  const phase = runner.fullIntegrity(CONTEXT, controller.signal).then(
    () => {
      settlements += 1;
      return "resolved";
    },
    (error: unknown) => {
      settlements += 1;
      return error instanceof Error && "code" in error
        ? String((error as Error & { code: unknown }).code)
        : String(error);
    },
  );
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown): void => { unhandled.push(error); };
  process.on("unhandledRejection", onUnhandled);

  try {
    controller.abort();
    worker.emit("error", new Error("late worker failure"));
    worker.emit("messageerror", new Error("late protocol failure"));
    worker.emit("exit", 1);

    assert.equal(await phase, "WORKER_CLOSED");
    worker.termination.reject(new Error("late termination cleanup failure"));
    worker.emit("message", { ok: true, data: { late: true } });
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(settlements, 1);
    assert.equal(worker.terminateCalls, 1);
    assert.deepEqual(unhandled, []);
    assert.deepEqual(
      ["message", "messageerror", "error", "exit"].map((event) => (
        worker.listenerCount(event)
      )),
      [0, 0, 0, 0],
    );
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});
