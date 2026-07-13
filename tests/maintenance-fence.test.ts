import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";
import type { ProjectId } from "../src/orchestrator/identity/contracts.js";
import { DEFAULT_BUSY_TIMEOUT_MS } from "../src/orchestrator/runtime/runtime-capabilities.js";
import {
  MaintenanceFence,
  type MaintenanceLease,
} from "../src/orchestrator/storage/maintenance-fence.js";
import { MigrationRunner } from "../src/orchestrator/storage/migration-runner.js";
import { eventCoreMigration } from "../src/orchestrator/storage/migrations/0001-event-core.js";
import { NodeSqliteDriver } from "../src/orchestrator/storage/node-sqlite-driver.js";
import type { SqliteConnection } from "../src/orchestrator/storage/sqlite-driver.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111" as ProjectId;
const roots: string[] = [];
const connections: SqliteConnection[] = [];
const driver = new NodeSqliteDriver({ DatabaseSync });

function createConnection(): SqliteConnection {
  const root = mkdtempSync(join(tmpdir(), "memory-maintenance-"));
  roots.push(root);
  const connection = driver.open(join(root, "events.sqlite"), {
    mode: "create",
    busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS,
  });
  connections.push(connection);
  new MigrationRunner().apply(
    connection,
    [eventCoreMigration],
    "2026-07-13T00:00:00.000Z",
  );
  connection.exec("BEGIN IMMEDIATE");
  connection.prepare(`
    INSERT INTO project_meta(
      singleton, project_id, vault_id, store_id, schema_version, created_at
    ) VALUES (1, $projectId, $vaultId, $storeId, 1, $createdAt)
  `).run({
    $projectId: PROJECT_ID,
    $vaultId: "22222222-2222-4222-8222-222222222222",
    $storeId: "33333333-3333-4333-8333-333333333333",
    $createdAt: "2026-07-13T00:00:00.000Z",
  });
  connection.exec(`
    INSERT INTO maintenance_state(
      singleton, epoch, mode, owner_id, fencing_token, lease_expires_at, requested_at
    ) VALUES (1, 0, 'idle', NULL, 0, NULL, NULL)
  `);
  connection.exec("COMMIT");
  return connection;
}

function transaction<T>(connection: SqliteConnection, action: () => T): T {
  connection.exec("BEGIN IMMEDIATE");
  try {
    const result = action();
    connection.exec("COMMIT");
    return result;
  } catch (error) {
    try { connection.exec("ROLLBACK"); } catch { /* preserve original */ }
    throw error;
  }
}

function expectCode(action: () => unknown, code: string): Error & { code: string } {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error, `expected ${code}`);
  assert.equal((caught as Error & { code?: unknown }).code, code);
  return caught as Error & { code: string };
}

function state(connection: SqliteConnection): Record<string, unknown> {
  const row = connection.prepare(`
    SELECT epoch, mode, owner_id, fencing_token, lease_expires_at, requested_at
    FROM maintenance_state WHERE singleton = 1
  `).get() as Record<string, unknown>;
  return { ...row };
}

afterEach(() => {
  for (const connection of connections.splice(0)) {
    try { connection.close(); } catch { /* cleanup continues */ }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("MaintenanceFence", () => {
  it("fails closed for a missing singleton and rejects every append while quiescing", () => {
    const connection = createConnection();
    const fence = new MaintenanceFence();

    transaction(connection, () => fence.assertAppendAllowed(connection));
    transaction(connection, () => {
      connection.exec(`
        UPDATE maintenance_state
        SET mode = 'quiescing', owner_id = 'maintenance-a', epoch = 1,
            fencing_token = 1, lease_expires_at = '2026-07-13T02:00:00.000Z',
            requested_at = '2026-07-13T01:00:00.000Z'
      `);
    });
    expectCode(
      () => transaction(connection, () => fence.assertAppendAllowed(connection)),
      "MAINTENANCE_QUIESCING",
    );

    transaction(connection, () => connection.exec("DELETE FROM maintenance_state"));
    expectCode(
      () => transaction(connection, () => fence.assertAppendAllowed(connection)),
      "MAINTENANCE_STATE_INVALID",
    );
  });

  it("registers, renews, and closes an executor without changing its binding identity", () => {
    const connection = createConnection();
    const fence = new MaintenanceFence();

    transaction(connection, () => fence.registerExecutor(
      connection,
      PROJECT_ID,
      "executor-a",
      7,
      "fingerprint-a",
      "2026-07-13T03:00:00.000Z",
      "2026-07-13T01:00:00.000Z",
    ));
    transaction(connection, () => fence.renewExecutor(
      connection,
      PROJECT_ID,
      "executor-a",
      "2026-07-13T04:00:00.000Z",
      "2026-07-13T01:30:00.000Z",
    ));
    assert.deepEqual({ ...connection.prepare(`
      SELECT binding_generation, context_fingerprint, opened_at, last_seen_at,
             lease_expires_at, closed_at
      FROM executor_leases WHERE project_id = $projectId AND executor_id = $executorId
    `).get({ $projectId: PROJECT_ID, $executorId: "executor-a" }) }, {
      binding_generation: 7n,
      context_fingerprint: "fingerprint-a",
      opened_at: "2026-07-13T01:00:00.000Z",
      last_seen_at: "2026-07-13T01:30:00.000Z",
      lease_expires_at: "2026-07-13T04:00:00.000Z",
      closed_at: null,
    });

    transaction(connection, () => fence.closeExecutor(
      connection,
      PROJECT_ID,
      "executor-a",
      "2026-07-13T02:00:00.000Z",
    ));
    assert.equal(connection.prepare(`
      SELECT closed_at FROM executor_leases
      WHERE project_id = $projectId AND executor_id = $executorId
    `).get({ $projectId: PROJECT_ID, $executorId: "executor-a" })?.closed_at,
    "2026-07-13T02:00:00.000Z");
    expectCode(
      () => transaction(connection, () => fence.renewExecutor(
        connection,
        PROJECT_ID,
        "executor-a",
        "2026-07-13T05:00:00.000Z",
        "2026-07-13T02:30:00.000Z",
      )),
      "EXECUTOR_LEASE_NOT_ACTIVE",
    );
  });

  it("rejects executor registration during quiescing even after the maintenance lease expires", () => {
    const connection = createConnection();
    const fence = new MaintenanceFence();
    transaction(connection, () => fence.acquire(
      connection,
      "maintenance-a",
      "2026-07-13T01:30:00.000Z",
      "2026-07-13T01:00:00.000Z",
    ));

    expectCode(
      () => transaction(connection, () => fence.registerExecutor(
        connection,
        PROJECT_ID,
        "executor-late",
        1,
        "fingerprint",
        "2026-07-13T04:00:00.000Z",
        "2026-07-13T02:00:00.000Z",
      )),
      "MAINTENANCE_QUIESCING",
    );
  });

  it("acquires a monotonic fence and snapshots only live unexpired executors by instant", () => {
    const connection = createConnection();
    const fence = new MaintenanceFence();
    transaction(connection, () => {
      fence.registerExecutor(
        connection,
        PROJECT_ID,
        "executor-live",
        1,
        "live",
        "2026-07-13T03:00:00+02:00",
        "2026-07-13T00:00:00Z",
      );
      fence.registerExecutor(
        connection,
        PROJECT_ID,
        "executor-expired",
        1,
        "expired",
        "2026-07-13T00:30:00Z",
        "2026-07-13T00:00:00Z",
      );
      fence.registerExecutor(
        connection,
        PROJECT_ID,
        "executor-offset-expired",
        1,
        "offset-expired",
        "2026-07-13T02:30:00+02:00",
        "2026-07-13T00:00:00Z",
      );
    });

    const lease = transaction(connection, () => fence.acquire(
      connection,
      "maintenance-a",
      "2026-07-13T04:00:00Z",
      "2026-07-13T00:45:00Z",
    ));
    assert.deepEqual(lease, {
      epoch: 1n,
      fencingToken: 1n,
      ownerId: "maintenance-a",
      leaseExpiresAt: "2026-07-13T04:00:00Z",
    });
    assert.deepEqual(connection.prepare(`
      SELECT executor_id FROM maintenance_required_executors
      WHERE epoch = 1 ORDER BY executor_id
    `).all().map((row) => row.executor_id), ["executor-live"]);
    expectCode(
      () => transaction(connection, () => fence.acquire(
        connection,
        "maintenance-b",
        "2026-07-13T05:00:00Z",
        "2026-07-13T01:00:00Z",
      )),
      "MAINTENANCE_ALREADY_ACTIVE",
    );
  });

  it("accepts acknowledgements only from the immutable snapshot and exact fencing token after executor close", () => {
    const connection = createConnection();
    const fence = new MaintenanceFence();
    transaction(connection, () => fence.registerExecutor(
      connection,
      PROJECT_ID,
      "executor-a",
      1,
      "fingerprint-a",
      "2026-07-13T03:00:00Z",
      "2026-07-13T00:00:00Z",
    ));
    const lease = transaction(connection, () => fence.acquire(
      connection,
      "maintenance-a",
      "2026-07-13T04:00:00Z",
      "2026-07-13T01:00:00Z",
    ));

    expectCode(
      () => transaction(connection, () => fence.acknowledge(
        connection,
        { ...lease, fencingToken: lease.fencingToken + 1n },
        "executor-a",
        "2026-07-13T01:05:00Z",
      )),
      "MAINTENANCE_LEASE_STALE",
    );
    expectCode(
      () => transaction(connection, () => fence.acknowledge(
        connection,
        lease,
        "executor-not-snapshotted",
        "2026-07-13T01:05:00Z",
      )),
      "MAINTENANCE_EXECUTOR_NOT_REQUIRED",
    );
    assert.equal(fence.allRequiredExecutorsAcknowledged(connection, lease), false);
    transaction(connection, () => fence.acknowledge(
      connection,
      lease,
      "executor-a",
      "2026-07-13T01:05:00Z",
    ));
    transaction(connection, () => fence.acknowledge(
      connection,
      lease,
      "executor-a",
      "2026-07-13T01:06:00Z",
    ));
    assert.equal(fence.allRequiredExecutorsAcknowledged(connection, lease), false);
    transaction(connection, () => fence.closeExecutor(
      connection,
      PROJECT_ID,
      "executor-a",
      "2026-07-13T01:07:00Z",
    ));
    assert.equal(fence.allRequiredExecutorsAcknowledged(connection, lease), true);
    transaction(connection, () => fence.release(
      connection,
      lease,
      true,
      "2026-07-13T01:10:00Z",
    ));
    assert.deepEqual(state(connection), {
      epoch: 1n,
      mode: "idle",
      owner_id: null,
      fencing_token: 1n,
      lease_expires_at: null,
      requested_at: null,
    });
  });

  it("does not turn later executor expiry or closure into an acknowledgement", () => {
    const connection = createConnection();
    const fence = new MaintenanceFence();
    transaction(connection, () => fence.registerExecutor(
      connection,
      PROJECT_ID,
      "executor-a",
      1,
      "fingerprint-a",
      "2026-07-13T02:00:00Z",
      "2026-07-13T00:00:00Z",
    ));
    const lease = transaction(connection, () => fence.acquire(
      connection,
      "maintenance-a",
      "2026-07-13T05:00:00Z",
      "2026-07-13T01:00:00Z",
    ));
    transaction(connection, () => fence.closeExecutor(
      connection,
      PROJECT_ID,
      "executor-a",
      "2026-07-13T02:30:00Z",
    ));

    assert.equal(fence.allRequiredExecutorsAcknowledged(connection, lease), false);
    expectCode(
      () => transaction(connection, () => fence.release(
        connection,
        lease,
        true,
        "2026-07-13T03:00:00Z",
      )),
      "MAINTENANCE_ACKNOWLEDGEMENT_REQUIRED",
    );
    assert.equal(state(connection).mode, "quiescing");

    transaction(connection, () => fence.release(
      connection,
      lease,
      false,
      "2026-07-13T03:01:00Z",
    ));
    const next = transaction(connection, () => fence.acquire(
      connection,
      "maintenance-b",
      "2026-07-13T06:00:00Z",
      "2026-07-13T03:02:00Z",
    ));
    assert.deepEqual([next.epoch, next.fencingToken], [2n, 2n]);
    assert.equal(connection.prepare(`
      SELECT count(*) AS count FROM maintenance_required_executors WHERE epoch = 2
    `).get()?.count, 0n);
    transaction(connection, () => fence.release(
      connection,
      next,
      true,
      "2026-07-13T03:03:00Z",
    ));
  });

  it("replaces an expired maintenance lease and prevents the stale owner from clearing it", () => {
    const connection = createConnection();
    const fence = new MaintenanceFence();
    const first = transaction(connection, () => fence.acquire(
      connection,
      "maintenance-a",
      "2026-07-13T02:00:00Z",
      "2026-07-13T01:00:00Z",
    ));
    const second = transaction(connection, () => fence.acquire(
      connection,
      "maintenance-b",
      "2026-07-13T05:00:00Z",
      "2026-07-13T03:00:00Z",
    ));
    assert.deepEqual([second.epoch, second.fencingToken], [2n, 2n]);

    expectCode(
      () => transaction(connection, () => fence.release(
        connection,
        first,
        false,
        "2026-07-13T03:01:00Z",
      )),
      "MAINTENANCE_LEASE_STALE",
    );
    assert.deepEqual(state(connection), {
      epoch: 2n,
      mode: "quiescing",
      owner_id: "maintenance-b",
      fencing_token: 2n,
      lease_expires_at: "2026-07-13T05:00:00Z",
      requested_at: "2026-07-13T03:00:00Z",
    });
  });

  it("fails closed when callers present a structurally malformed lease", () => {
    const connection = createConnection();
    const fence = new MaintenanceFence();
    const malformed = {
      epoch: -1n,
      fencingToken: 0n,
      ownerId: "",
      leaseExpiresAt: "not-a-time",
    } as MaintenanceLease;
    expectCode(
      () => transaction(connection, () => fence.release(
        connection,
        malformed,
        false,
        "2026-07-13T01:00:00Z",
      )),
      "MAINTENANCE_LEASE_INVALID",
    );
  });

  it("fails closed when persisted maintenance counters, times, or snapshot tokens are inconsistent", () => {
    const connection = createConnection();
    const fence = new MaintenanceFence();
    transaction(connection, () => connection.exec(`
      UPDATE maintenance_state
      SET epoch = 1, mode = 'quiescing', owner_id = 'maintenance-a',
          fencing_token = 2, lease_expires_at = '2026-07-13T01:00:00Z',
          requested_at = '2026-07-13T02:00:00Z'
    `));
    expectCode(
      () => transaction(connection, () => fence.assertAppendAllowed(connection)),
      "MAINTENANCE_STATE_INVALID",
    );

    transaction(connection, () => connection.exec(`
      UPDATE maintenance_state
      SET epoch = 0, mode = 'idle', owner_id = NULL, fencing_token = 0,
          lease_expires_at = NULL, requested_at = NULL
    `));
    transaction(connection, () => fence.registerExecutor(
      connection,
      PROJECT_ID,
      "executor-a",
      1,
      "fingerprint-a",
      "2026-07-13T04:00:00Z",
      "2026-07-13T01:00:00Z",
    ));
    const lease = transaction(connection, () => fence.acquire(
      connection,
      "maintenance-a",
      "2026-07-13T05:00:00Z",
      "2026-07-13T02:00:00Z",
    ));
    transaction(connection, () => connection.prepare(`
      UPDATE maintenance_required_executors
      SET fencing_token = $wrongToken
      WHERE epoch = $epoch AND executor_id = $executorId
    `).run({
      $wrongToken: lease.fencingToken + 1n,
      $epoch: lease.epoch,
      $executorId: "executor-a",
    }));
    expectCode(
      () => transaction(connection, () => fence.allRequiredExecutorsAcknowledged(
        connection,
        lease,
      )),
      "MAINTENANCE_STATE_INVALID",
    );
  });
});
