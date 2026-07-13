import type { ProjectId } from "../identity/contracts.js";
import type { SqliteConnection, SqliteRow } from "./sqlite-driver.js";

export interface MaintenanceLease {
  epoch: bigint;
  fencingToken: bigint;
  ownerId: string;
  leaseExpiresAt: string;
}

export type ExecutorHeartbeatResult =
  | { mode: "idle"; renewed: true }
  | { mode: "quiescing"; lease: MaintenanceLease };

export class MaintenanceFenceError extends Error {
  constructor(
    readonly code: string,
    readonly details: Record<string, string | number | boolean> = {},
  ) {
    super(code);
    this.name = "MaintenanceFenceError";
  }
}

interface MaintenanceState {
  epoch: bigint;
  mode: "idle" | "quiescing";
  ownerId: string | null;
  fencingToken: bigint;
  leaseExpiresAt: string | null;
  requestedAt: string | null;
}

const SQLITE_INT64_MAX = 9_223_372_036_854_775_807n;
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/;

function fail(
  code: string,
  details: Record<string, string | number | boolean> = {},
): never {
  throw new MaintenanceFenceError(code, details);
}

function nonEmpty(value: unknown, code: string): string {
  if (typeof value !== "string" || value.trim().length === 0) fail(code);
  return value;
}

function timestampInstant(value: unknown, code: string): bigint {
  if (typeof value !== "string") fail(code);
  const match = RFC3339.exec(value);
  if (match === null) fail(code);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const offsetHour = match[8] === "Z" ? 0 : Number(match[10]);
  const offsetMinute = match[8] === "Z" ? 0 : Number(match[11]);
  if (
    year < 1
    || month < 1
    || month > 12
    || day < 1
    || day > (monthDays[month - 1] ?? 0)
    || hour < 0
    || hour > 23
    || minute < 0
    || minute > 59
    || second < 0
    || second > 59
    || offsetHour < 0
    || offsetHour > 23
    || offsetMinute < 0
    || offsetMinute > 59
  ) {
    fail(code);
  }

  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  const offsetSign = match[8] === "Z" || match[9] === "+" ? 1 : -1;
  const offsetMilliseconds = offsetSign * ((offsetHour * 60) + offsetMinute) * 60_000;
  const fractionalNanoseconds = BigInt((match[7] ?? "").padEnd(9, "0") || "0");
  return (BigInt(date.getTime() - offsetMilliseconds) * 1_000_000n)
    + fractionalNanoseconds;
}

function positiveSafeInteger(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) fail(code);
  return Number(value);
}

function bigint(value: unknown, code: string, minimum = 0n): bigint {
  if (typeof value !== "bigint" || value < minimum || value > SQLITE_INT64_MAX) {
    fail(code);
  }
  return value;
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function readState(connection: SqliteConnection): MaintenanceState {
  const rows = connection.prepare(`
    SELECT epoch, mode, owner_id, fencing_token, lease_expires_at, requested_at
    FROM maintenance_state
    WHERE singleton = 1
  `).all();
  if (rows.length !== 1) fail("MAINTENANCE_STATE_INVALID");
  const row = rows[0] as SqliteRow;
  const epoch = bigint(row.epoch, "MAINTENANCE_STATE_INVALID");
  const fencingToken = bigint(row.fencing_token, "MAINTENANCE_STATE_INVALID");
  if (
    epoch !== fencingToken
    ||
    (row.mode !== "idle" && row.mode !== "quiescing")
    || !nullableString(row.owner_id)
    || !nullableString(row.lease_expires_at)
    || !nullableString(row.requested_at)
  ) {
    fail("MAINTENANCE_STATE_INVALID");
  }
  if (row.mode === "idle") {
    if (row.owner_id !== null || row.lease_expires_at !== null || row.requested_at !== null) {
      fail("MAINTENANCE_STATE_INVALID");
    }
  } else {
    if (
      epoch < 1n
      || fencingToken < 1n
      || row.owner_id === null
      || row.owner_id.trim().length === 0
      || row.lease_expires_at === null
      || row.requested_at === null
    ) {
      fail("MAINTENANCE_STATE_INVALID");
    }
    const leaseInstant = timestampInstant(
      row.lease_expires_at,
      "MAINTENANCE_STATE_INVALID",
    );
    const requestedInstant = timestampInstant(
      row.requested_at,
      "MAINTENANCE_STATE_INVALID",
    );
    if (leaseInstant <= requestedInstant) fail("MAINTENANCE_STATE_INVALID");
  }
  return {
    epoch,
    mode: row.mode,
    ownerId: row.owner_id,
    fencingToken,
    leaseExpiresAt: row.lease_expires_at,
    requestedAt: row.requested_at,
  };
}

function assertLeaseShape(lease: MaintenanceLease): void {
  if (
    typeof lease !== "object"
    || lease === null
    || typeof lease.epoch !== "bigint"
    || lease.epoch < 1n
    || lease.epoch > SQLITE_INT64_MAX
    || typeof lease.fencingToken !== "bigint"
    || lease.fencingToken < 1n
    || lease.fencingToken > SQLITE_INT64_MAX
    || typeof lease.ownerId !== "string"
    || lease.ownerId.trim().length === 0
  ) {
    fail("MAINTENANCE_LEASE_INVALID");
  }
  timestampInstant(lease.leaseExpiresAt, "MAINTENANCE_LEASE_INVALID");
}

function assertCurrentLease(
  connection: SqliteConnection,
  lease: MaintenanceLease,
  now?: string,
): MaintenanceState {
  assertLeaseShape(lease);
  const state = readState(connection);
  if (
    state.mode !== "quiescing"
    || state.epoch !== lease.epoch
    || state.fencingToken !== lease.fencingToken
    || state.ownerId !== lease.ownerId
    || state.leaseExpiresAt !== lease.leaseExpiresAt
  ) {
    fail("MAINTENANCE_LEASE_STALE");
  }
  if (
    now !== undefined
    && timestampInstant(lease.leaseExpiresAt, "MAINTENANCE_LEASE_INVALID")
      <= timestampInstant(now, "MAINTENANCE_TIMESTAMP_INVALID")
  ) {
    fail("MAINTENANCE_LEASE_STALE");
  }
  return state;
}

export class MaintenanceFence {
  assertAppendAllowed(connection: SqliteConnection): void {
    if (readState(connection).mode === "quiescing") {
      fail("MAINTENANCE_QUIESCING");
    }
  }

  registerExecutor(
    connection: SqliteConnection,
    projectId: ProjectId,
    executorId: string,
    bindingGeneration: number,
    contextFingerprint: string,
    leaseExpiresAt: string,
    now: string,
  ): void {
    if (readState(connection).mode === "quiescing") fail("MAINTENANCE_QUIESCING");
    const project = nonEmpty(projectId, "EXECUTOR_LEASE_INVALID");
    const executor = nonEmpty(executorId, "EXECUTOR_LEASE_INVALID");
    const fingerprint = nonEmpty(contextFingerprint, "EXECUTOR_LEASE_INVALID");
    const generation = positiveSafeInteger(bindingGeneration, "EXECUTOR_LEASE_INVALID");
    const nowInstant = timestampInstant(now, "MAINTENANCE_TIMESTAMP_INVALID");
    if (timestampInstant(leaseExpiresAt, "MAINTENANCE_TIMESTAMP_INVALID") <= nowInstant) {
      fail("EXECUTOR_LEASE_INVALID");
    }

    const existing = connection.prepare(`
      SELECT binding_generation, context_fingerprint, closed_at
      FROM executor_leases
      WHERE project_id = $projectId AND executor_id = $executorId
    `).get({ $projectId: project, $executorId: executor });
    if (existing === undefined) {
      connection.prepare(`
        INSERT INTO executor_leases(
          project_id, executor_id, binding_generation, context_fingerprint,
          opened_at, last_seen_at, lease_expires_at, closed_at
        ) VALUES (
          $projectId, $executorId, $bindingGeneration, $contextFingerprint,
          $openedAt, $lastSeenAt, $leaseExpiresAt, NULL
        )
      `).run({
        $projectId: project,
        $executorId: executor,
        $bindingGeneration: generation,
        $contextFingerprint: fingerprint,
        $openedAt: now,
        $lastSeenAt: now,
        $leaseExpiresAt: leaseExpiresAt,
      });
      return;
    }

    if (
      existing.closed_at === null
      && (existing.binding_generation !== BigInt(generation)
        || existing.context_fingerprint !== fingerprint)
    ) {
      fail("EXECUTOR_BINDING_MISMATCH");
    }
    const changed = connection.prepare(`
      UPDATE executor_leases
      SET binding_generation = $bindingGeneration,
          context_fingerprint = $contextFingerprint,
          opened_at = CASE WHEN closed_at IS NULL THEN opened_at ELSE $openedAt END,
          last_seen_at = $lastSeenAt,
          lease_expires_at = $leaseExpiresAt,
          closed_at = NULL
      WHERE project_id = $projectId AND executor_id = $executorId
    `).run({
      $bindingGeneration: generation,
      $contextFingerprint: fingerprint,
      $openedAt: now,
      $lastSeenAt: now,
      $leaseExpiresAt: leaseExpiresAt,
      $projectId: project,
      $executorId: executor,
    }).changes;
    if (changed !== 1n) fail("EXECUTOR_LEASE_NOT_ACTIVE");
  }

  renewExecutor(
    connection: SqliteConnection,
    projectId: ProjectId,
    executorId: string,
    leaseExpiresAt: string,
    now: string,
  ): void {
    const project = nonEmpty(projectId, "EXECUTOR_LEASE_INVALID");
    const executor = nonEmpty(executorId, "EXECUTOR_LEASE_INVALID");
    const nowInstant = timestampInstant(now, "MAINTENANCE_TIMESTAMP_INVALID");
    if (timestampInstant(leaseExpiresAt, "MAINTENANCE_TIMESTAMP_INVALID") <= nowInstant) {
      fail("EXECUTOR_LEASE_INVALID");
    }
    const row = connection.prepare(`
      SELECT lease_expires_at, closed_at
      FROM executor_leases
      WHERE project_id = $projectId AND executor_id = $executorId
    `).get({ $projectId: project, $executorId: executor });
    if (
      row === undefined
      || row.closed_at !== null
      || typeof row.lease_expires_at !== "string"
      || timestampInstant(row.lease_expires_at, "EXECUTOR_LEASE_INVALID") <= nowInstant
    ) {
      fail("EXECUTOR_LEASE_NOT_ACTIVE");
    }
    const changed = connection.prepare(`
      UPDATE executor_leases
      SET last_seen_at = $lastSeenAt,
          lease_expires_at = $leaseExpiresAt
      WHERE project_id = $projectId
        AND executor_id = $executorId
        AND closed_at IS NULL
    `).run({
      $lastSeenAt: now,
      $leaseExpiresAt: leaseExpiresAt,
      $projectId: project,
      $executorId: executor,
    }).changes;
    if (changed !== 1n) fail("EXECUTOR_LEASE_NOT_ACTIVE");
  }

  /**
   * Performs the worker heartbeat decision in one short write transaction.
   * An idle store renews the executor lease. A quiescing store is observed
   * without renewal and returns the exact maintenance lease that the worker
   * must acknowledge after draining its accepted FIFO.
   */
  heartbeatExecutor(
    connection: SqliteConnection,
    projectId: ProjectId,
    executorId: string,
    leaseExpiresAt: string,
    now: string,
  ): ExecutorHeartbeatResult {
    connection.exec("BEGIN IMMEDIATE");
    try {
      const state = readState(connection);
      let result: ExecutorHeartbeatResult;
      if (state.mode === "idle") {
        this.renewExecutor(
          connection,
          projectId,
          executorId,
          leaseExpiresAt,
          now,
        );
        result = { mode: "idle", renewed: true };
      } else {
        if (
          state.ownerId === null
          || state.leaseExpiresAt === null
          || state.epoch < 1n
          || state.fencingToken < 1n
        ) {
          fail("MAINTENANCE_STATE_INVALID");
        }
        result = {
          mode: "quiescing",
          lease: {
            epoch: state.epoch,
            fencingToken: state.fencingToken,
            ownerId: state.ownerId,
            leaseExpiresAt: state.leaseExpiresAt,
          },
        };
      }
      connection.exec("COMMIT");
      return result;
    } catch (error) {
      try { connection.exec("ROLLBACK"); } catch { /* preserve heartbeat failure */ }
      throw error;
    }
  }

  closeExecutor(
    connection: SqliteConnection,
    projectId: ProjectId,
    executorId: string,
    now: string,
  ): void {
    const project = nonEmpty(projectId, "EXECUTOR_LEASE_INVALID");
    const executor = nonEmpty(executorId, "EXECUTOR_LEASE_INVALID");
    timestampInstant(now, "MAINTENANCE_TIMESTAMP_INVALID");
    const changed = connection.prepare(`
      UPDATE executor_leases
      SET last_seen_at = $lastSeenAt,
          closed_at = $closedAt
      WHERE project_id = $projectId
        AND executor_id = $executorId
        AND closed_at IS NULL
    `).run({
      $lastSeenAt: now,
      $closedAt: now,
      $projectId: project,
      $executorId: executor,
    }).changes;
    if (changed !== 1n) fail("EXECUTOR_LEASE_NOT_ACTIVE");
  }

  confirmExecutorClosed(
    connection: SqliteConnection,
    lease: MaintenanceLease,
    projectId: ProjectId,
    executorId: string,
    now: string,
  ): void {
    assertCurrentLease(connection, lease, now);
    const executor = nonEmpty(executorId, "MAINTENANCE_EXECUTOR_NOT_REQUIRED");
    const confirmation = connection.prepare(`
      SELECT required.fencing_token AS required_fencing_token,
             acknowledged.fencing_token AS acknowledged_fencing_token
      FROM maintenance_required_executors AS required
      LEFT JOIN maintenance_acknowledgements AS acknowledged
        ON acknowledged.epoch = required.epoch
       AND acknowledged.executor_id = required.executor_id
      WHERE required.epoch = $epoch AND required.executor_id = $executorId
    `).get({
      $epoch: lease.epoch,
      $executorId: executor,
    });
    if (confirmation?.required_fencing_token !== lease.fencingToken) {
      fail("MAINTENANCE_EXECUTOR_NOT_REQUIRED");
    }
    if (confirmation.acknowledged_fencing_token !== lease.fencingToken) {
      fail("MAINTENANCE_ACKNOWLEDGEMENT_REQUIRED");
    }
    this.closeExecutor(connection, projectId, executor, now);
  }

  acquire(
    connection: SqliteConnection,
    ownerId: string,
    leaseExpiresAt: string,
    now: string,
  ): MaintenanceLease {
    const owner = nonEmpty(ownerId, "MAINTENANCE_LEASE_INVALID");
    const nowInstant = timestampInstant(now, "MAINTENANCE_TIMESTAMP_INVALID");
    const leaseInstant = timestampInstant(
      leaseExpiresAt,
      "MAINTENANCE_LEASE_INVALID",
    );
    if (leaseInstant <= nowInstant) fail("MAINTENANCE_LEASE_INVALID");
    const state = readState(connection);
    if (
      state.mode === "quiescing"
      && state.leaseExpiresAt !== null
      && timestampInstant(state.leaseExpiresAt, "MAINTENANCE_STATE_INVALID") > nowInstant
    ) {
      fail("MAINTENANCE_ALREADY_ACTIVE");
    }
    if (state.epoch >= SQLITE_INT64_MAX || state.fencingToken >= SQLITE_INT64_MAX) {
      fail("MAINTENANCE_COUNTER_EXHAUSTED");
    }
    const epoch = state.epoch + 1n;
    const fencingToken = state.fencingToken + 1n;
    const changed = connection.prepare(`
      UPDATE maintenance_state
      SET epoch = $epoch,
          mode = 'quiescing',
          owner_id = $ownerId,
          fencing_token = $fencingToken,
          lease_expires_at = $leaseExpiresAt,
          requested_at = $requestedAt
      WHERE singleton = 1
        AND epoch = $previousEpoch
        AND fencing_token = $previousFencingToken
    `).run({
      $epoch: epoch,
      $ownerId: owner,
      $fencingToken: fencingToken,
      $leaseExpiresAt: leaseExpiresAt,
      $requestedAt: now,
      $previousEpoch: state.epoch,
      $previousFencingToken: state.fencingToken,
    }).changes;
    if (changed !== 1n) fail("MAINTENANCE_LEASE_STALE");

    const activeExecutors = connection.prepare(`
      SELECT executor_id, lease_expires_at
      FROM executor_leases
      WHERE closed_at IS NULL
      ORDER BY project_id, executor_id
    `).all();
    const insertRequired = connection.prepare(`
      INSERT INTO maintenance_required_executors(
        epoch, executor_id, fencing_token, required_at
      ) VALUES ($epoch, $executorId, $fencingToken, $requiredAt)
    `);
    for (const executor of activeExecutors) {
      if (
        typeof executor.executor_id !== "string"
        || typeof executor.lease_expires_at !== "string"
      ) {
        fail("EXECUTOR_LEASE_INVALID");
      }
      if (
        timestampInstant(executor.lease_expires_at, "EXECUTOR_LEASE_INVALID")
        > nowInstant
      ) {
        insertRequired.run({
          $epoch: epoch,
          $executorId: executor.executor_id,
          $fencingToken: fencingToken,
          $requiredAt: now,
        });
      }
    }
    return { epoch, fencingToken, ownerId: owner, leaseExpiresAt };
  }

  acknowledge(
    connection: SqliteConnection,
    lease: MaintenanceLease,
    executorId: string,
    now: string,
  ): void {
    assertCurrentLease(connection, lease, now);
    const executor = nonEmpty(executorId, "MAINTENANCE_EXECUTOR_NOT_REQUIRED");
    timestampInstant(now, "MAINTENANCE_TIMESTAMP_INVALID");
    const required = connection.prepare(`
      SELECT fencing_token
      FROM maintenance_required_executors
      WHERE epoch = $epoch AND executor_id = $executorId
    `).get({ $epoch: lease.epoch, $executorId: executor });
    if (required?.fencing_token !== lease.fencingToken) {
      fail("MAINTENANCE_EXECUTOR_NOT_REQUIRED");
    }
    connection.prepare(`
      INSERT INTO maintenance_acknowledgements(
        epoch, executor_id, fencing_token, acknowledged_at
      ) VALUES ($epoch, $executorId, $fencingToken, $acknowledgedAt)
      ON CONFLICT(epoch, executor_id) DO NOTHING
    `).run({
      $epoch: lease.epoch,
      $executorId: executor,
      $fencingToken: lease.fencingToken,
      $acknowledgedAt: now,
    });
    const acknowledged = connection.prepare(`
      SELECT fencing_token
      FROM maintenance_acknowledgements
      WHERE epoch = $epoch AND executor_id = $executorId
    `).get({ $epoch: lease.epoch, $executorId: executor });
    if (acknowledged?.fencing_token !== lease.fencingToken) {
      fail("MAINTENANCE_LEASE_STALE");
    }
  }

  allRequiredExecutorsAcknowledged(
    connection: SqliteConnection,
    lease: MaintenanceLease,
  ): boolean {
    assertCurrentLease(connection, lease);
    const snapshot = connection.prepare(`
      SELECT count(*) AS total,
             count(CASE WHEN fencing_token = $fencingToken THEN 1 END) AS matching
      FROM maintenance_required_executors
      WHERE epoch = $epoch
    `).get({
      $epoch: lease.epoch,
      $fencingToken: lease.fencingToken,
    });
    if (
      typeof snapshot?.total !== "bigint"
      || typeof snapshot.matching !== "bigint"
      || snapshot.total !== snapshot.matching
    ) {
      fail("MAINTENANCE_STATE_INVALID");
    }
    const row = connection.prepare(`
      SELECT count(*) AS missing
      FROM maintenance_required_executors AS required
      LEFT JOIN maintenance_acknowledgements AS acknowledged
        ON acknowledged.epoch = required.epoch
       AND acknowledged.executor_id = required.executor_id
       AND acknowledged.fencing_token = required.fencing_token
      LEFT JOIN executor_leases AS executor
        ON executor.executor_id = required.executor_id
      WHERE required.epoch = $epoch
        AND required.fencing_token = $fencingToken
        AND (
          acknowledged.executor_id IS NULL
          OR executor.executor_id IS NULL
          OR executor.closed_at IS NULL
        )
    `).get({
      $epoch: lease.epoch,
      $fencingToken: lease.fencingToken,
    });
    if (typeof row?.missing !== "bigint") fail("MAINTENANCE_STATE_INVALID");
    return row.missing === 0n;
  }

  release(
    connection: SqliteConnection,
    lease: MaintenanceLease,
    requireAllAcknowledged: boolean,
    now: string,
  ): void {
    assertCurrentLease(connection, lease, now);
    if (typeof requireAllAcknowledged !== "boolean") {
      fail("MAINTENANCE_LEASE_INVALID");
    }
    if (
      requireAllAcknowledged
      && !this.allRequiredExecutorsAcknowledged(connection, lease)
    ) {
      fail("MAINTENANCE_ACKNOWLEDGEMENT_REQUIRED");
    }
    const changed = connection.prepare(`
      UPDATE maintenance_state
      SET mode = 'idle',
          owner_id = NULL,
          lease_expires_at = NULL,
          requested_at = NULL
      WHERE singleton = 1
        AND mode = 'quiescing'
        AND epoch = $epoch
        AND fencing_token = $fencingToken
        AND owner_id = $ownerId
        AND lease_expires_at = $leaseExpiresAt
    `).run({
      $epoch: lease.epoch,
      $fencingToken: lease.fencingToken,
      $ownerId: lease.ownerId,
      $leaseExpiresAt: lease.leaseExpiresAt,
    }).changes;
    if (changed !== 1n) fail("MAINTENANCE_LEASE_STALE");
  }
}
