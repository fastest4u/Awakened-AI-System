import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
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
const FROZEN_0002_SHA256 = "68B4039048A359C523B7842F6D17BAA5760E9760D2B4E9F80BB8A48DC339EB06";
const FROZEN_0002_SQL_SHA256 = "85666a0bdee4455068f03a81e9d3720df172d15fce6d8e6f0cb3f5f7d0a81293";
const HISTORICAL_SCHEMA_TWO_READER_PROVENANCE = Object.freeze({
  commit: "866bb0d22ac4225b8a06db9e528a9eaed847c02c",
  sourcePath: "src/orchestrator/storage/schema-compatibility.ts",
  sourceSha256: "3523c39c117309d6d7a6e0f0b0a5e0a00631e7f44df55927c146f519bdf5972a",
});
const HISTORICAL_SCHEMA_TWO_MIGRATIONS = Object.freeze([
  Object.freeze({
    version: 1,
    name: "event-core",
    sourcePath: "src/orchestrator/storage/migrations/0001-event-core.ts",
  }),
  Object.freeze({
    version: 2,
    name: "session-lifecycle",
    sourcePath: "src/orchestrator/storage/migrations/0002-session-lifecycle.ts",
  }),
]);
const FROZEN_SCHEMA_TWO_READER_ARTIFACT_SHA256 = "e3d5f2e12320cfc81821ab937fbabd49f2d3ef231f93822971791a7a90e1ec45";
const HISTORICAL_SCHEMA_TWO_READER_ARTIFACT = `
const { parentPort, workerData } = require("node:worker_threads");
const { createHash } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

class SchemaCompatibilityError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function fail(code) {
  throw new SchemaCompatibilityError(code);
}

function migrationChecksum(migration) {
  return createHash("sha256").update(migration.sql, "utf8").digest("hex");
}

function numeric(value) {
  if (typeof value !== "number" && typeof value !== "bigint") return undefined;
  const result = Number(value);
  return Number.isSafeInteger(result) ? result : undefined;
}

function tableExists(connection, name) {
  return numeric(connection.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = $name").get({ $name: name })?.count) === 1;
}

function readRecordedMigrations(connection) {
  if (!tableExists(connection, "schema_migrations")) return [];
  return connection.prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version").all().map((row) => {
    const version = numeric(row.version);
    if (version === undefined || version <= 0 || typeof row.name !== "string" || typeof row.checksum !== "string") {
      fail("MIGRATION_CHECKSUM_MISMATCH");
    }
    return { version, name: row.name, checksum: row.checksum };
  });
}

function verifyRecordedMigrationPrefix(recorded, registry) {
  const targetVersion = registry.length;
  if (recorded.some((row) => row.version > targetVersion)) fail("SCHEMA_TOO_NEW");
  for (const [index, row] of recorded.entries()) {
    const expected = registry[index];
    if (
      expected === undefined
      || row.version !== index + 1
      || row.version !== expected.version
      || row.name !== expected.name
      || row.checksum !== migrationChecksum(expected)
    ) fail("MIGRATION_CHECKSUM_MISMATCH");
  }
}

const PROJECT_STORE_MIGRATIONS = Object.freeze(workerData.registry.map((migration) => Object.freeze({
  version: migration.version,
  name: migration.name,
  sql: migration.sql,
})));
const database = new DatabaseSync(workerData.eventsPath, { readOnly: true });
let decodeInvocations = 0;
try {
  const recorded = readRecordedMigrations(database);
  verifyRecordedMigrationPrefix(recorded, PROJECT_STORE_MIGRATIONS);
  for (const event of database.prepare("SELECT event_type, event_schema_version FROM events").all()) {
    decodeInvocations += 1;
    void event;
  }
  parentPort.postMessage({ code: "OK", decodeInvocations });
} catch (error) {
  parentPort.postMessage({
    code: error instanceof SchemaCompatibilityError ? error.code : "STORE_UNAVAILABLE",
    decodeInvocations,
  });
} finally {
  database.close();
}
`;

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

function responseEnvelope(value, id) {
  const response = record(value, "worker response");
  if (response.id !== id || typeof response.ok !== "boolean") {
    throw new Error("Worker returned an unexpected response envelope");
  }
  return response;
}

function workerRequest(worker, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Worker ${message.type} request timed out`)), REQUEST_TIMEOUT_MS);
    const finish = (callback, value) => {
      clearTimeout(timer);
      worker.off("message", onMessage);
      worker.off("messageerror", onMessageError);
      worker.off("error", onError);
      callback(value);
    };
    const onMessage = (value) => {
      try {
        const response = responseEnvelope(value, message.id);
        finish(resolve, response);
      } catch (error) {
        if (typeof value === "object" && value !== null && value.type === "upgrade-quiesce-required") return;
        finish(reject, error);
      }
    };
    const onMessageError = () => finish(reject, new Error("Worker emitted an unreadable message"));
    const onError = (error) => finish(reject, error);
    worker.on("message", onMessage);
    worker.on("messageerror", onMessageError);
    worker.on("error", onError);
    worker.postMessage(message);
  });
}

function lifecycleRecoveryProbe() {
  return {
    kind: "fenced",
    operation: "workflow-recovery",
    input: {
      operation: "workflow-recovery",
      workId: "smoke-recovery-scan",
      ownerId: "smoke-worker",
      fencingToken: "1",
      dueBefore: "2026-07-17T00:00:00.000Z",
      limit: 1,
    },
  };
}

function lifecycleRowCounts(eventsPath) {
  const database = new DatabaseSync(eventsPath, { readOnly: true });
  try {
    return {
      event_count: Number(database.prepare("SELECT count(*) AS count FROM events").get()?.count),
      dedup_count: Number(database.prepare("SELECT count(*) AS count FROM command_dedup").get()?.count),
      workflow_count: Number(database.prepare("SELECT count(*) AS count FROM workflow_instances").get()?.count),
    };
  } finally {
    database.close();
  }
}

function verifyHistoricalSchemaTwoReaderArtifact() {
  const sourceHash = createHash("sha256")
    .update(HISTORICAL_SCHEMA_TWO_READER_ARTIFACT, "utf8")
    .digest("hex");
  if (sourceHash !== FROZEN_SCHEMA_TWO_READER_ARTIFACT_SHA256) {
    throw new Error("Frozen historical schema-2 reader artifact checksum changed");
  }
}

async function runHistoricalSchemaTwoReader(eventsPath, registry) {
  const reader = new Worker(HISTORICAL_SCHEMA_TWO_READER_ARTIFACT, {
    eval: true,
    workerData: { eventsPath, registry },
  });
  try {
    return await waitForHistoricalSchemaTwoReader(reader);
  } finally {
    await reader.terminate().catch(() => undefined);
  }
}

async function assertHistoricalSchemaTwoReaderCompatibility(schemaTwoEventsPath, schemaFiveEventsPath, registry) {
  verifyHistoricalSchemaTwoReaderArtifact();
  const schemaTwo = await runHistoricalSchemaTwoReader(schemaTwoEventsPath, registry);
  if (schemaTwo?.code !== "OK" || schemaTwo.decodeInvocations !== 0) {
    throw new Error("Historical schema-2 reader must accept a valid schema-2 store");
  }
  const schemaFive = await runHistoricalSchemaTwoReader(schemaFiveEventsPath, registry);
  if (schemaFive?.code !== "SCHEMA_TOO_NEW" || schemaFive.decodeInvocations !== 0) {
    throw new Error("Old schema-2 reader must report SCHEMA_TOO_NEW before lifecycle-event decoding");
  }
}

function waitForHistoricalSchemaTwoReader(reader) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reader.off("message", onMessage);
      reader.off("messageerror", onMessageError);
      reader.off("error", onError);
      callback(value);
    };
    const onMessage = (value) => finish(resolve, value);
    const onMessageError = () => finish(reject, new Error("Old schema-2 reader emitted unreadable output"));
    const onError = (error) => finish(reject, error);
    const timer = setTimeout(
      () => finish(reject, new Error("Old schema-2 reader timed out")),
      REQUEST_TIMEOUT_MS,
    );
    reader.on("message", onMessage);
    reader.on("messageerror", onMessageError);
    reader.on("error", onError);
  });
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(",")}}`;
}

function historicalGitShow(sourcePath) {
  try {
    return execFileSync("git", ["show", `${HISTORICAL_SCHEMA_TWO_READER_PROVENANCE.commit}:${sourcePath}`]);
  } catch {
    throw new Error("Historical schema-2 provenance is unavailable");
  }
}

function historicalMigrationFromSource(sourcePath, expectedVersion, expectedName) {
  const source = historicalGitShow(sourcePath).toString("utf8");
  const match = /version:\s*(\d+),\s*\n\s*name:\s*"([^"]+)",\s*\n\s*sql:\s*`([\s\S]*?)`,\s*\n};/.exec(source);
  if (match === null || Number(match[1]) !== expectedVersion || match[2] !== expectedName) {
    throw new Error("Historical schema-2 migration provenance is invalid");
  }
  return Object.freeze({
    version: expectedVersion,
    name: expectedName,
    sql: match[3],
    checksum: createHash("sha256").update(match[3], "utf8").digest("hex"),
  });
}

function historicalSchemaTwoRegistry() {
  const sourceBytes = historicalGitShow(HISTORICAL_SCHEMA_TWO_READER_PROVENANCE.sourcePath);
  const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
  if (sourceHash !== HISTORICAL_SCHEMA_TWO_READER_PROVENANCE.sourceSha256) {
    throw new Error("Historical schema-2 compatibility source checksum changed");
  }
  return Object.freeze(HISTORICAL_SCHEMA_TWO_MIGRATIONS.map((migration) =>
    historicalMigrationFromSource(migration.sourcePath, migration.version, migration.name)));
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

function createUpgradeFixture(historicalRegistry) {
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

  const schemaTwoEventsPath = join(storeRoot, "historical-schema-two.sqlite");
  const schemaTwo = new DatabaseSync(schemaTwoEventsPath);
  try {
    const [eventCore, sessionLifecycle] = historicalRegistry;
    if (eventCore === undefined || sessionLifecycle === undefined) {
      throw new Error("Historical schema-2 registry is incomplete");
    }
    schemaTwo.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA application_id = ${PROJECT_MEMORY_APPLICATION_ID};
    `);
    schemaTwo.exec(eventCore.sql);
    schemaTwo.prepare(`
      INSERT INTO schema_migrations(version, name, checksum, applied_at)
      VALUES (?, ?, ?, ?)
    `).run(eventCore.version, eventCore.name, eventCore.checksum, NOW);
    schemaTwo.prepare(`
      INSERT INTO project_meta(
        singleton, project_id, vault_id, store_id, schema_version, created_at
      ) VALUES (1, ?, ?, ?, 1, ?)
    `).run(PROJECT_ID, VAULT_ID, STORE_ID, NOW);
    schemaTwo.exec(`
      INSERT INTO maintenance_state(
        singleton, epoch, mode, owner_id, fencing_token, lease_expires_at, requested_at
      ) VALUES (1, 0, 'idle', NULL, 0, NULL, NULL)
    `);
    schemaTwo.exec(sessionLifecycle.sql);
    schemaTwo.prepare(`
      INSERT INTO schema_migrations(version, name, checksum, applied_at)
      VALUES (?, ?, ?, ?)
    `).run(sessionLifecycle.version, sessionLifecycle.name, sessionLifecycle.checksum, NOW);
    schemaTwo.prepare("UPDATE project_meta SET schema_version = 2 WHERE singleton = 1").run();
  } finally {
    schemaTwo.close();
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
    schemaTwoEventsPath,
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
    || JSON.stringify(result.appliedVersions) !== "[2,3,4,5]"
  ) throw new Error("Bundled upgrade did not apply pending Versions 2 through 5 exactly once");
  const integrity = record(result.integrity, "upgrade integrity");
  if (integrity.ok !== true) throw new Error("Bundled upgrade integrity did not pass");
  return result;
}

async function smokeBundledUpgrade() {
  const historicalRegistry = historicalSchemaTwoRegistry();
  const fixture = createUpgradeFixture(historicalRegistry);
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
      if (JSON.stringify(versions) !== "[1,2,3,4,5]") {
        throw new Error(`Bundled upgrade recorded unexpected migrations ${JSON.stringify(versions)}`);
      }
      const schemaVersion = Number(database.prepare(`
        SELECT schema_version FROM project_meta WHERE singleton = 1
      `).get()?.schema_version);
      if (schemaVersion !== 5) {
        throw new Error(`Bundled upgrade recorded schema version ${schemaVersion}`);
      }
      const migration0002 = database.prepare(
        "SELECT checksum FROM schema_migrations WHERE version = 2",
      ).get()?.checksum;
      const frozenMigration0002 = createHash("sha256").update(readFileSync(
        new URL("../src/orchestrator/storage/migrations/0002-session-lifecycle.ts", import.meta.url),
        "utf8",
      ).replace(/\r\n?/g, "\n"), "utf8").digest("hex").toUpperCase();
      if (
        frozenMigration0002 !== FROZEN_0002_SHA256
        || migration0002 !== FROZEN_0002_SQL_SHA256
      ) {
        throw new Error("Bundled upgrade changed frozen migration 0002 checksum");
      }
    } finally {
      database.close();
    }
    const manifest = JSON.parse(readFileSync(fixture.manifestPath, "utf8"));
    if (manifest.lastIntegrity?.status !== "passed") {
      throw new Error("Bundled upgrade did not publish the integrity manifest");
    }
    if (manifest.schemaVersion !== 1) {
      throw new Error("Bundled upgrade did not preserve manifest format version 1");
    }
    await assertHistoricalSchemaTwoReaderCompatibility(
      fixture.schemaTwoEventsPath,
      fixture.eventsPath,
      historicalRegistry,
    );

    const storeWorker = new Worker(WORKER_URL, {
      workerData: {
        role: "store",
        executorLeaseMs: 15_000,
        heartbeatIntervalMs: 5_000,
        appendRetryDeadlineMs: 15_000,
      },
    });
    try {
      const opened = await workerRequest(storeWorker, {
        id: "smoke-disabled-open",
        type: "open",
        binding: fixture.binding,
      });
      if (opened.ok !== true) throw new Error("Worker open failed before disabled lifecycle probe");
      const before = lifecycleRowCounts(fixture.eventsPath);
      const lifecycle = await workerRequest(storeWorker, {
        id: "smoke-disabled-lifecycle",
        type: "lifecycle",
        binding: {
          projectId: fixture.binding.projectId,
          vaultId: fixture.binding.vaultId,
          storeId: fixture.binding.storeId,
          bindingGeneration: fixture.binding.bindingGeneration,
          contextFingerprint: fixture.binding.contextFingerprint,
        },
        operation: lifecycleRecoveryProbe(),
      });
      if (lifecycle.ok !== false || lifecycle.error?.code !== "LIFECYCLE_V2_DISABLED") {
        throw new Error("Production lifecycle V2 must remain disabled");
      }
      const after = lifecycleRowCounts(fixture.eventsPath);
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        throw new Error("Disabled lifecycle probe had non-zero lifecycle event/dedup/workflow effect");
      }
      const closed = await workerRequest(storeWorker, { id: "smoke-disabled-close", type: "close" });
      if (closed.ok !== true) throw new Error("Worker close failed after disabled lifecycle probe");
    } finally {
      await storeWorker.terminate().catch(() => undefined);
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
