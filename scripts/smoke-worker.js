import { createHash } from "node:crypto";
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
import { Worker } from "node:worker_threads";

const MINIMUM_NODE_VERSION = "22.22.3";
const MINIMUM_SQLITE_VERSION = "3.51.3";
const REQUEST_TIMEOUT_MS = 10_000;
const UPGRADE_TIMEOUT_MS = 30_000;
const WORKER_URL = new URL("../dist/workers/project-store.worker.js", import.meta.url);
const PROJECT_MEMORY_APPLICATION_ID = 0x504d454d;
const NOW = "2026-07-16T00:00:00.000Z";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const VAULT_ID = "22222222-2222-4222-8222-222222222222";
const STORE_ID = "33333333-3333-4333-8333-333333333333";
const WORKSPACE_ID = "build-artifact-smoke-workspace";

function parseStableVersion(value, label) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (!match) throw new Error(`${label} must be a stable numeric x.y.z version, received ${value}`);
  return match.slice(1).map(Number);
}

function compareVersions(left, right) {
  const observed = parseStableVersion(left, "observed version");
  const minimum = parseStableVersion(right, "minimum version");
  for (let index = 0; index < observed.length; index += 1) {
    if (observed[index] !== minimum[index]) return Math.sign(observed[index] - minimum[index]);
  }
  return 0;
}

function record(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function exact(value, expectedKeys, label) {
  const observed = record(value, label);
  const actualKeys = Object.keys(observed).sort();
  const sortedExpected = [...expectedKeys].sort();
  if (
    actualKeys.length !== sortedExpected.length
    || actualKeys.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new Error(`${label} has an invalid shape`);
  }
  return observed;
}

function assertJson(value, label, ancestors = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object") throw new Error(`${label} must contain only JSON-safe values`);
  if (ancestors.has(value)) throw new Error(`${label} must not contain cycles`);
  ancestors.add(value);
  if (Array.isArray(value)) {
    value.forEach((item) => assertJson(item, label, ancestors));
    ancestors.delete(value);
    return;
  }
  const object = record(value, label);
  Object.values(object).forEach((item) => assertJson(item, label, ancestors));
  ancestors.delete(value);
}

function decodeResponse(value, expectedId, decodeData) {
  const response = record(value, "worker response");
  const keys = response.ok === false ? ["id", "ok", "error"] : ["id", "ok", "data"];
  exact(response, keys, "worker response");
  if (response.id !== expectedId) throw new Error(`Unexpected worker response id ${String(response.id)}`);
  if (response.ok === false) {
    const failure = exact(response.error, ["code", "message", "details"], "worker failure");
    if (typeof failure.code !== "string" || typeof failure.message !== "string") {
      throw new Error("Worker failure code and message must be strings");
    }
    const details = record(failure.details, "worker failure details");
    assertJson(details, "worker failure details");
    throw new Error(
      `Worker request failed: ${failure.code}: ${failure.message}: ${JSON.stringify(details)}`,
    );
  }
  if (response.ok !== true) throw new Error("Worker response ok must be a boolean");
  return decodeData(response.data);
}

function decodePing(value) {
  const ping = exact(value, ["nodeVersion", "sqliteVersion", "walSafe"], "ping response");
  if (typeof ping.nodeVersion !== "string" || typeof ping.sqliteVersion !== "string") {
    throw new Error("Ping response versions must be strings");
  }
  if (ping.walSafe !== true) throw new Error("Worker did not confirm a WAL-safe SQLite runtime");
  if (compareVersions(ping.nodeVersion, MINIMUM_NODE_VERSION) < 0) {
    throw new Error(`Worker Node ${ping.nodeVersion} is below ${MINIMUM_NODE_VERSION}`);
  }
  if (compareVersions(ping.sqliteVersion, MINIMUM_SQLITE_VERSION) < 0) {
    throw new Error(`Worker SQLite ${ping.sqliteVersion} is below ${MINIMUM_SQLITE_VERSION}`);
  }
  return ping;
}

function decodeClose(value) {
  const closed = exact(value, ["closed"], "close response");
  if (closed.closed !== true) throw new Error("Worker did not acknowledge close");
  return closed;
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(",")}}`;
}

function eventCoreSql() {
  const source = readFileSync(
    new URL("../src/orchestrator/storage/migrations/0001-event-core.ts", import.meta.url),
    "utf8",
  ).replace(/\r\n?/g, "\n");
  const match = /sql:\s*`([\s\S]*?)`,\s*};/.exec(source);
  if (match === null) throw new Error("Unable to read the Version 1 migration fixture");
  return match[1];
}

function createUpgradeFixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "memory-build-upgrade-")));
  const projectRoot = join(root, "project");
  const vaultRoot = join(projectRoot, "memory");
  const storeRoot = join(vaultRoot, ".memory-mcp", "v2");
  const descriptorPath = join(vaultRoot, ".memory-mcp", "project-identity.json");
  mkdirSync(storeRoot, { recursive: true });
  const storeRoute = {
    kind: "vault-local",
    storeRoot,
    eventsPath: join(storeRoot, "events.sqlite"),
    storeManifestPath: join(storeRoot, "store-manifest.json"),
    projectionManifestPath: join(storeRoot, "projection-manifest.json"),
  };
  writeFileSync(descriptorPath, `${JSON.stringify({
    schemaVersion: 1,
    projectId: PROJECT_ID,
    vaultId: VAULT_ID,
    createdAt: NOW,
  }, null, 2)}\n`, "utf8");
  writeFileSync(storeRoute.storeManifestPath, `${JSON.stringify({
    schemaVersion: 1,
    storeId: STORE_ID,
    projectId: PROJECT_ID,
    vaultId: VAULT_ID,
    createdAt: NOW,
    lastIntegrity: { status: "never" },
  }, null, 2)}\n`, "utf8");

  const sql = eventCoreSql();
  const database = new DatabaseSync(storeRoute.eventsPath);
  try {
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA application_id = ${PROJECT_MEMORY_APPLICATION_ID};
    `);
    database.exec(sql);
    database.prepare(`
      INSERT INTO schema_migrations(version, name, checksum, applied_at)
      VALUES (1, 'event-core', ?, ?)
    `).run(createHash("sha256").update(sql, "utf8").digest("hex"), NOW);
    database.prepare(`
      INSERT INTO project_meta(
        singleton, project_id, vault_id, store_id, schema_version, created_at
      ) VALUES (1, ?, ?, ?, 1, ?)
    `).run(PROJECT_ID, VAULT_ID, STORE_ID, NOW);
    database.exec(`
      INSERT INTO maintenance_state(
        singleton, epoch, mode, owner_id, fencing_token, lease_expires_at, requested_at
      ) VALUES (1, 0, 'idle', NULL, 0, NULL, NULL)
    `);
  } finally {
    database.close();
  }

  const workspace = {
    kind: "non-git",
    workspaceRoot: projectRoot,
    workspaceId: WORKSPACE_ID,
  };
  const fingerprintMaterial = {
    generation: 1,
    source: "explicit-cli",
    projectId: PROJECT_ID,
    vaultId: VAULT_ID,
    storeId: STORE_ID,
    workspaceId: WORKSPACE_ID,
    projectRoot,
    vaultRoot,
    descriptorPath,
    storeRoute,
    workspace,
    clientNamespace: "build-artifact-smoke",
    clientInstanceId: "build-artifact-smoke-client",
    actorRole: "maintenance",
  };
  const contextFingerprint = createHash("sha256")
    .update(`project-memory/project-context/v1\n${canonicalJson(fingerprintMaterial)}`, "utf8")
    .digest("hex");
  return {
    root,
    eventsPath: storeRoute.eventsPath,
    manifestPath: storeRoute.storeManifestPath,
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
      descriptorPath: fingerprintMaterial.descriptorPath,
      storeRoute,
      workspaceId: WORKSPACE_ID,
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

function decodeUpgrade(value) {
  const result = exact(
    value,
    ["plan", "appliedVersions", "resumedPostCommit", "integrity"],
    "upgrade result",
  );
  if (
    !Array.isArray(result.appliedVersions)
    || JSON.stringify(result.appliedVersions) !== "[2,3]"
  ) throw new Error("Bundled upgrade did not apply pending Versions 2 and 3 exactly once");
  const integrity = record(result.integrity, "upgrade integrity");
  if (integrity.ok !== true) throw new Error("Bundled upgrade integrity did not pass");
  return result;
}

async function smokeBundledUpgrade() {
  const fixture = createUpgradeFixture();
  const worker = new Worker(WORKER_URL, {
    workerData: { role: "upgrade", binding: fixture.binding },
  });
  const operationId = "smoke-upgrade-apply";
  let settled = false;
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Bundled upgrade request timed out")),
        UPGRADE_TIMEOUT_MS,
      );
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback(value);
      };
      worker.on("message", (value) => {
        try {
          const message = record(value, "upgrade worker message");
          if (message.type === "upgrade-quiesce-required") {
            if (message.operationId !== operationId) {
              throw new Error("Bundled upgrade requested quiesce for the wrong operation");
            }
            worker.postMessage({
              type: "upgrade-quiesce-complete",
              operationId,
            });
            return;
          }
          decodeResponse(value, operationId, decodeUpgrade);
          finish(resolve);
        } catch (error) {
          finish(reject, error);
        }
      });
      worker.on("messageerror", () => finish(
        reject,
        new Error("Bundled upgrade worker emitted an unreadable message"),
      ));
      worker.on("error", (error) => finish(reject, error));
      worker.on("exit", (code) => {
        if (!settled) finish(reject, new Error(`Bundled upgrade worker exited with code ${code}`));
      });
      worker.postMessage({ id: operationId, type: "upgrade-apply" });
    });

    const database = new DatabaseSync(fixture.eventsPath, { readOnly: true });
    try {
      const versions = database.prepare(
        "SELECT version FROM schema_migrations ORDER BY version",
      ).all().map((row) => Number(row.version));
      if (JSON.stringify(versions) !== "[1,2,3]") {
        throw new Error(`Bundled upgrade recorded unexpected migrations ${JSON.stringify(versions)}`);
      }
    } finally {
      database.close();
    }
    const manifest = JSON.parse(readFileSync(fixture.manifestPath, "utf8"));
    if (manifest.lastIntegrity?.status !== "passed") {
      throw new Error("Bundled upgrade did not publish the integrity manifest");
    }
  } finally {
    await worker.terminate().catch(() => undefined);
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

async function main() {
  const worker = new Worker(WORKER_URL, {
    workerData: {
      role: "store",
      executorLeaseMs: 15_000,
      heartbeatIntervalMs: 5_000,
      appendRetryDeadlineMs: 15_000,
    },
  });
  const pending = new Map();
  let exited = false;
  let lifecycleFailure;
  let resolveExit;
  const exitPromise = new Promise((resolve) => {
    resolveExit = resolve;
  });

  function fail(error) {
    lifecycleFailure ??= error instanceof Error ? error : new Error(String(error));
    for (const [id, request] of pending) {
      clearTimeout(request.timer);
      request.reject(lifecycleFailure);
      pending.delete(id);
    }
  }

  worker.on("message", (value) => {
    try {
      const envelope = record(value, "worker message");
      if (typeof envelope.id !== "string") throw new Error("Unexpected unsolicited worker message");
      const request = pending.get(envelope.id);
      if (!request) throw new Error(`Unexpected worker response id ${envelope.id}`);
      const result = decodeResponse(value, envelope.id, request.decodeData);
      clearTimeout(request.timer);
      pending.delete(envelope.id);
      request.resolve(result);
    } catch (error) {
      fail(error);
    }
  });
  worker.on("messageerror", () => fail(new Error("Worker emitted an unreadable message")));
  worker.on("error", (error) => fail(error));
  worker.on("exit", (code) => {
    exited = true;
    if (code !== 0) fail(new Error(`Worker exited abnormally with code ${code}`));
    if (pending.size > 0) fail(new Error("Worker exited before replying to every request"));
    resolveExit(code);
  });

  function request(id, type, decodeData) {
    if (lifecycleFailure) return Promise.reject(lifecycleFailure);
    if (exited) return Promise.reject(new Error("Worker has already exited"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Worker ${type} request timed out`));
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, { decodeData, reject, resolve, timer });
      try {
        worker.postMessage({ id, type });
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      }
    });
  }

  function waitForExit() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Worker did not exit after close acknowledgement")),
        REQUEST_TIMEOUT_MS,
      );
      exitPromise.then((code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  }

  let ping;
  try {
    ping = await request("smoke-ping", "ping", decodePing);
    await request("smoke-close", "close", decodeClose);
    const exitCode = await waitForExit();
    if (lifecycleFailure) throw lifecycleFailure;
    if (exitCode !== 0) throw new Error(`Worker exited abnormally with code ${exitCode}`);
  } finally {
    if (!exited) await worker.terminate();
  }

  await smokeBundledUpgrade();

  process.stdout.write(
    `Worker artifacts OK: Node ${ping.nodeVersion}, SQLite ${ping.sqliteVersion}, bundled upgrade phases passed\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
