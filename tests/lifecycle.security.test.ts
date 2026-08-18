import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";
import { LifecycleFixtureClient } from "./support/lifecycle-fixture-client.js";
import { LifecycleTestKeyBroker } from "./support/lifecycle-test-key-broker.js";

const FIXTURE_PATH = fileURLToPath(new URL("./fixtures/lifecycle-validation-profile-child.js", import.meta.url));
const ROOT_FIXTURE_PATH = fileURLToPath(new URL("./fixtures/project-store-lifecycle-child.js", import.meta.url));
const clients = new Set<LifecycleFixtureClient>();
const roots: string[] = [];

class InspectingLifecycleTestKeyBroker extends LifecycleTestKeyBroker {
  readonly returnedMacs: Uint8Array[] = [];

  override mac(input: Parameters<LifecycleTestKeyBroker["mac"]>[0]): Uint8Array {
    const output = super.mac(input);
    this.returnedMacs.push(output);
    return output;
  }
}

afterEach(async () => {
  await Promise.all([...clients].map(async (client) => {
    try { await client.dispose(); } catch { await client.forceCleanup(); }
  }));
  clients.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function assertNoCanaryInFiles(root: string, canaries: readonly string[]): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      assertNoCanaryInFiles(path, canaries);
      continue;
    }
    if (!entry.isFile() || statSync(path).size === 0) continue;
    const bytes = readFileSync(path);
    try {
      for (const canary of canaries) {
        assert.equal(bytes.includes(Buffer.from(canary, "utf8")), false, `retained ${canary} in ${path}`);
      }
    } finally {
      bytes.fill(0);
    }
  }
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function assertNoCanaryInDecodedStore(eventsPath: string, canaries: readonly string[]): void {
  const database = new DatabaseSync(eventsPath, { readOnly: true });
  try {
    const tables = database.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    `).all() as unknown as readonly { readonly name: string }[];
    for (const { name } of tables) {
      const columns = database.prepare(`PRAGMA table_info(${quoteIdentifier(name)})`).all() as unknown as readonly {
        readonly name: string;
        readonly type: string;
      }[];
      const retained = columns.filter((column) => /TEXT|BLOB/iu.test(column.type));
      if (retained.length === 0) continue;
      const statement = database.prepare(
        `SELECT ${retained.map((column) => quoteIdentifier(column.name)).join(", ")} FROM ${quoteIdentifier(name)}`,
      );
      for (const row of statement.all() as readonly Record<string, unknown>[]) {
        for (const value of Object.values(row)) {
          const bytes = typeof value === "string"
            ? Buffer.from(value, "utf8")
            : value instanceof Uint8Array
              ? Buffer.from(value)
              : null;
          if (bytes === null) continue;
          try {
            for (const canary of canaries) {
              assert.equal(bytes.includes(Buffer.from(canary, "utf8")), false, `decoded ${name} retained ${canary}`);
            }
          } finally {
            bytes.fill(0);
          }
        }
      }
    }
  } finally {
    database.close();
  }
}

function fixtureEnvironment(canary: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { TASK18_ENV_CANARY: canary };
  for (const key of ["PATH", "SystemRoot", "WINDIR", "ComSpec", "TEMP", "TMP", "NODE_PATH"] as const) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  return environment;
}

function result(message: { readonly type: string; readonly value?: unknown }): Record<string, unknown> {
  assert.equal(message.type, "result");
  assert.ok(message.value !== null && typeof message.value === "object");
  return message.value as Record<string, unknown>;
}

describe("Task 18 lifecycle retained-secret safety", () => {
  it("keeps parent-owned key material and key RPC inputs out of real IPC and project artifacts", async () => {
    const canaries = [
      "TASK18_HANDLE_CANARY",
      "TASK18_RESUME_TOKEN_CANARY",
      "TASK18_PROOF_MAC_CANARY",
      "TASK18_APPROVAL_CANARY",
      "TASK18_CHILD_BINDING_GRANT_CANARY",
      "TASK18_PROVIDER_KEY_CANARY",
      "TASK18_PENDING_PLAINTEXT_CANARY",
      "TASK18_RAW_EVIDENCE_CANARY",
      "TASK18_RAW_VALIDATION_CANARY",
      "TASK18_ENV_CANARY",
      "TASK18_PROCESS_COMMAND_CANARY",
    ];
    const broker = new InspectingLifecycleTestKeyBroker({ seed: canaries.join("/") });
    const root = mkdtempSync(join(tmpdir(), "task18-security-"));
    roots.push(root);
    const projectRoot = join(root, "project");
    const vaultRoot = join(projectRoot, "memory");
    mkdirSync(vaultRoot, { recursive: true });
    const scope = { projectId: "project-security", storeId: "store-security" };
    const key = broker.currentKey(scope, "child-session-handle");
    const bytes = Buffer.from(canaries.join("|"), "utf8");
    broker.fingerprint({
      ...scope,
      purpose: "child-session-handle",
      keyId: key.keyId,
      domain: "task18-security",
      bytes,
    });
    bytes.fill(0);
    const brokerText = JSON.stringify(broker.calls);
    assert.ok(!canaries.some((canary) => brokerText.includes(canary)));
    assert.ok(!brokerText.includes("bytes"));

    const client = new LifecycleFixtureClient({
      fixturePath: ROOT_FIXTURE_PATH,
      timeoutMs: 15_000,
      cleanupTimeoutMs: 15_000,
      keyBroker: broker,
      stderrCanaries: canaries,
    });
    clients.add(client);
    try {
      await client.ready();
      const started = await client.start({
        projectRoot,
        vaultRoot,
        clientInstanceId: "task18-security",
        useParentKeyBroker: true,
      });
      assert.equal(started.type, "started");
      const eventsPath = (started.payload as Record<string, unknown>).eventsPath;
      if (typeof eventsPath !== "string") assert.fail("fixture did not report eventsPath");
      const rootStart = result(await client.mutation({
        operation: "root-start",
        continuityKey: "task18-security-root",
        idempotencyKey: "task18-security-idempotency",
      }));
      assert.equal(rootStart.operation, "root-start");
      const childWorkflow = result(await client.mutation({ operation: "child-workflow" }));
      assert.equal(childWorkflow.operation, "child-workflow");
      assert.equal(childWorkflow.childState, "completed");
      assert.ok(!canaries.some((canary) => JSON.stringify(childWorkflow).includes(canary)));
      assert.ok(client.keyRequestAudit.length > 0);
      const auditText = JSON.stringify(client.keyRequestAudit);
      assert.ok(!canaries.some((canary) => auditText.includes(canary)));
      assert.ok(client.keyRequestAudit.every((request) => (
        !Object.prototype.hasOwnProperty.call(request, "bytes")
        && !Object.prototype.hasOwnProperty.call(request, "mac")
        && !Object.prototype.hasOwnProperty.call(request, "sealed")
      )));
      assert.equal(client.transport.workerData, undefined);
      assert.ok(!client.child.spawnargs.some((argument) => canaries.some((canary) => argument.includes(canary))));
      assert.ok(canaries.every((canary) => !client.stderrCanaryDetected(canary)));
      assertNoCanaryInFiles(projectRoot, canaries);
      assertNoCanaryInDecodedStore(eventsPath, canaries);
      await client.close();
      clients.delete(client);
      assert.ok(broker.returnedMacs.length > 0);
      assert.ok(broker.returnedMacs.every((mac) => mac.every((byte) => byte === 0)));
      assertNoCanaryInFiles(projectRoot, canaries);
      assertNoCanaryInDecodedStore(eventsPath, canaries);
    } finally {
      broker.shutdown();
    }
    assert.equal(broker.liveKeyMaterialCount, 0);
  });

  it("does not reflect raw validation output in the fixture response", async () => {
    const canary = "TASK18_RAW_VALIDATION_CANARY";
    const client = new LifecycleFixtureClient({
      fixturePath: FIXTURE_PATH,
      timeoutMs: 10_000,
      cleanupTimeoutMs: 10_000,
    });
    clients.add(client);
    await client.ready();
    await client.start({ projectId: "project-security-validation" });
    const response = await client.validation({ output: canary });
    assert.ok(!JSON.stringify(response).includes(canary));
    const value = response.type === "result" && response.value !== null && typeof response.value === "object"
      ? response.value as Record<string, unknown>
      : {};
    assert.equal(value.contentRetained, false);
    assert.equal(value.status, "pass");
    assert.equal(typeof value.outputFingerprint, "object");
  });

  it("keeps an actual fixture environment canary out of decoded store fields, sidecars, and stderr", async () => {
    const canary = "TASK18_ACTUAL_ENV_CANARY";
    const root = mkdtempSync(join(tmpdir(), "task18-security-environment-"));
    roots.push(root);
    const projectRoot = join(root, "project");
    const vaultRoot = join(projectRoot, "memory");
    mkdirSync(vaultRoot, { recursive: true });
    const client = new LifecycleFixtureClient({
      fixturePath: ROOT_FIXTURE_PATH,
      timeoutMs: 15_000,
      cleanupTimeoutMs: 15_000,
      env: fixtureEnvironment(canary),
      stderrCanaries: [canary],
    });
    clients.add(client);
    await client.ready();
    const started = await client.start({
      projectRoot,
      vaultRoot,
      clientInstanceId: "task18-security-environment",
    });
    assert.equal(started.type, "started");
    const eventsPath = (started.payload as Record<string, unknown>).eventsPath;
    if (typeof eventsPath !== "string") assert.fail("fixture did not report eventsPath");
    const recovery = result(await client.mutation({
      operation: "workflow-recovery",
      workId: "task18-security-environment-work",
      ownerId: "task18-security-environment-owner",
      fencingToken: "1",
      dueBefore: "2026-08-17T00:00:00.000Z",
      limit: 10,
    }));
    assert.equal((recovery.result as Record<string, unknown>).readOnly, true);
    assertNoCanaryInFiles(projectRoot, [canary]);
    assertNoCanaryInDecodedStore(eventsPath, [canary]);
    assert.equal(client.stderrCanaryDetected(canary), false);
    await client.close();
    clients.delete(client);
    assertNoCanaryInFiles(projectRoot, [canary]);
    assertNoCanaryInDecodedStore(eventsPath, [canary]);
  });
});
