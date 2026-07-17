import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import type { Clock } from "../src/orchestrator/runtime/clock.js";
import { SessionLeaseRepository } from "../src/orchestrator/storage/session-lease.repository.js";
import type {
  RootLeaseInsert,
  RootLeaseRecord,
  RootLeaseRelease,
  RootLeaseRenewal,
} from "../src/orchestrator/storage/lifecycle-storage.types.js";
import type {
  SqliteConnection,
  SqliteParams,
  SqliteRow,
  SqliteRunResult,
  SqliteStatement,
} from "../src/orchestrator/storage/sqlite-driver.js";
import type { LifecycleError } from "../src/orchestrator/lifecycle/errors.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const ROOT_ID = "44444444-4444-4444-8444-444444444444";
const CHILD_ID = "55555555-5555-4555-8555-555555555555";
const MAX_CANONICAL_TIMESTAMP_MS = 253_402_300_799_999n;

class FakeClock implements Clock {
  constructor(private value: bigint) {}

  nowMs(): bigint {
    return this.value;
  }

  set(value: bigint): void {
    this.value = value;
  }
}

class NativeStatement implements SqliteStatement {
  constructor(private readonly statement: import("node:sqlite").StatementSync) {
    statement.setReadBigInts(true);
  }

  run(params?: SqliteParams): SqliteRunResult {
    const result = params === undefined ? this.statement.run() : this.statement.run(params);
    return {
      changes: result.changes as bigint,
      lastInsertRowid: result.lastInsertRowid as bigint,
    };
  }

  get(params?: SqliteParams): SqliteRow | undefined {
    return (params === undefined ? this.statement.get() : this.statement.get(params)) as
      | SqliteRow
      | undefined;
  }

  all(params?: SqliteParams): SqliteRow[] {
    return (params === undefined ? this.statement.all() : this.statement.all(params)) as SqliteRow[];
  }

  iterate(params?: SqliteParams): IterableIterator<SqliteRow> {
    return (params === undefined ? this.statement.iterate() : this.statement.iterate(params)) as
      IterableIterator<SqliteRow>;
  }
}

class NativeConnection implements SqliteConnection {
  readonly database = new DatabaseSync(":memory:", {
    allowBareNamedParameters: false,
    allowUnknownNamedParameters: false,
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
  });

  exec(sql: string): void {
    this.database.exec(sql);
  }

  prepare(sql: string): SqliteStatement {
    return new NativeStatement(this.database.prepare(sql));
  }

  close(): void {
    this.database.close();
  }
}

class TransactionRejectingConnection implements SqliteConnection {
  execCalls = 0;
  closeCalls = 0;

  constructor(private readonly inner: SqliteConnection) {}

  exec(_sql: string): void {
    this.execCalls += 1;
    throw new Error("REPOSITORY_OWNS_TRANSACTION");
  }

  prepare(sql: string): SqliteStatement {
    return this.inner.prepare(sql);
  }

  close(): void {
    this.closeCalls += 1;
    throw new Error("REPOSITORY_CLOSED_CONNECTION");
  }
}

function expectCode(code: string, action: () => unknown): void {
  assert.throws(action, (error: unknown) => (error as LifecycleError).code === code);
}

function connection(): NativeConnection {
  const current = new NativeConnection();
  current.exec(`
    CREATE TABLE session_authority (
      project_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      session_kind TEXT NOT NULL CHECK (session_kind IN ('root', 'child')),
      semantic_state TEXT NOT NULL,
      owner_generation INTEGER,
      terminal_event_position INTEGER,
      PRIMARY KEY (project_id, session_id)
    ) STRICT;

    CREATE TABLE session_leases (
      project_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      owner_generation INTEGER NOT NULL CHECK (owner_generation > 0),
      owner_client_instance_id TEXT NOT NULL CHECK (length(trim(owner_client_instance_id)) > 0),
      acquired_at TEXT NOT NULL,
      renewed_at TEXT NOT NULL,
      last_observed_at_ms INTEGER NOT NULL CHECK (last_observed_at_ms >= 0),
      expires_at TEXT NOT NULL,
      released_at TEXT,
      PRIMARY KEY (project_id, session_id, owner_generation),
      FOREIGN KEY (project_id, session_id)
        REFERENCES session_authority(project_id, session_id)
    ) STRICT;

    CREATE UNIQUE INDEX session_leases_one_unreleased
    ON session_leases(project_id, session_id)
    WHERE released_at IS NULL;

    CREATE TRIGGER session_leases_insert_guard
    BEFORE INSERT ON session_leases
    WHEN NEW.released_at IS NULL AND NOT EXISTS (
      SELECT 1 FROM session_authority AS authority
      WHERE authority.project_id = NEW.project_id
        AND authority.session_id = NEW.session_id
        AND authority.session_kind = 'root'
        AND authority.owner_generation = NEW.owner_generation
        AND authority.terminal_event_position IS NULL
    )
    BEGIN
      SELECT RAISE(ABORT, 'SESSION_LEASE_AUTHORITY_MISMATCH');
    END;

    CREATE TRIGGER session_leases_update_guard
    BEFORE UPDATE ON session_leases
    WHEN NEW.released_at IS NULL AND NOT EXISTS (
      SELECT 1 FROM session_authority AS authority
      WHERE authority.project_id = NEW.project_id
        AND authority.session_id = NEW.session_id
        AND authority.session_kind = 'root'
        AND authority.owner_generation = NEW.owner_generation
        AND authority.terminal_event_position IS NULL
    )
    BEGIN
      SELECT RAISE(ABORT, 'SESSION_LEASE_AUTHORITY_MISMATCH');
    END;
  `);
  return current;
}

function seedAuthority(
  current: SqliteConnection,
  options: {
    readonly sessionId?: string;
    readonly kind?: "root" | "child";
    readonly ownerGeneration?: bigint | null;
    readonly terminalEventPosition?: bigint | null;
  } = {},
): void {
  current.prepare(`
    INSERT INTO session_authority(
      project_id, session_id, session_kind, semantic_state,
      owner_generation, terminal_event_position
    ) VALUES (
      $projectId, $sessionId, $sessionKind, 'active',
      $ownerGeneration, $terminalEventPosition
    )
  `).run({
    $projectId: PROJECT_ID,
    $sessionId: options.sessionId ?? ROOT_ID,
    $sessionKind: options.kind ?? "root",
    $ownerGeneration: options.ownerGeneration === undefined ? 1n : options.ownerGeneration,
    $terminalEventPosition: options.terminalEventPosition ?? null,
  });
}

function acquire(
  observedNowMs: bigint,
  overrides: Partial<RootLeaseInsert> = {},
): RootLeaseInsert {
  return {
    projectId: PROJECT_ID,
    sessionId: ROOT_ID,
    ownerGeneration: 1n,
    ownerClientInstanceId: "primary-1",
    observedNowMs,
    leaseDurationMs: 120_000n,
    ...overrides,
  };
}

function renew(
  observedNowMs: bigint,
  overrides: Partial<RootLeaseRenewal> = {},
): RootLeaseRenewal {
  return {
    projectId: PROJECT_ID,
    sessionId: ROOT_ID,
    ownerGeneration: 1n,
    ownerClientInstanceId: "primary-1",
    observedNowMs,
    leaseDurationMs: 120_000n,
    ...overrides,
  };
}

function release(
  lease: RootLeaseRecord,
  observedNowMs: bigint,
  overrides: Partial<RootLeaseRelease> = {},
): RootLeaseRelease {
  return {
    projectId: PROJECT_ID,
    sessionId: ROOT_ID,
    ownerGeneration: lease.ownerGeneration,
    ownerClientInstanceId: lease.ownerClientInstanceId,
    expectedLastObservedAtMs: lease.lastObservedAtMs,
    expectedExpiresAtMs: lease.expiresAtMs,
    observedNowMs,
    ...overrides,
  };
}

describe("SessionLeaseRepository deterministic clock rules", () => {
  it("acquires generation one with bigint epoch fields and no sleeping", () => {
    const current = connection();
    try {
      seedAuthority(current);
      const lease = new SessionLeaseRepository().insertGeneration(current, acquire(1_000n));
      assert.deepEqual(lease, {
        projectId: PROJECT_ID,
        sessionId: ROOT_ID,
        ownerGeneration: 1n,
        ownerClientInstanceId: "primary-1",
        acquiredAtMs: 1_000n,
        renewedAtMs: 1_000n,
        lastObservedAtMs: 1_000n,
        expiresAtMs: 121_000n,
        releasedAtMs: null,
      });
      assert.deepEqual(new SessionLeaseRepository().current(current, PROJECT_ID, ROOT_ID), lease);
    } finally {
      current.close();
    }
  });

  it("round-trips the last four-digit ISO instant and rejects expanded-year lease input", () => {
    const atLimit = connection();
    try {
      seedAuthority(atLimit);
      const lease = new SessionLeaseRepository().insertGeneration(atLimit, acquire(
        MAX_CANONICAL_TIMESTAMP_MS - 1n,
        { leaseDurationMs: 1n },
      ));
      assert.equal(lease.lastObservedAtMs, MAX_CANONICAL_TIMESTAMP_MS - 1n);
      assert.equal(lease.expiresAtMs, MAX_CANONICAL_TIMESTAMP_MS);
    } finally {
      atLimit.close();
    }

    const expandedYear = connection();
    try {
      seedAuthority(expandedYear);
      expectCode("LIFECYCLE_INPUT_INVALID", () => new SessionLeaseRepository().insertGeneration(
        expandedYear,
        acquire(MAX_CANONICAL_TIMESTAMP_MS + 1n, { leaseDurationMs: 1n }),
      ));
    } finally {
      expandedYear.close();
    }
  });

  it("clamps a backward clock and cannot revive an old lease", () => {
    const current = connection();
    try {
      seedAuthority(current);
      const clock = new FakeClock(1_000n);
      const leases = new SessionLeaseRepository();
      const first = leases.insertGeneration(current, acquire(clock.nowMs()));
      clock.set(900n);
      const renewed = leases.renewCurrent(current, renew(clock.nowMs()));
      assert.equal(renewed.lastObservedAtMs, first.lastObservedAtMs);
      assert.equal(renewed.renewedAtMs, first.lastObservedAtMs);
      assert.equal(renewed.expiresAtMs, first.lastObservedAtMs + 120_000n);
    } finally {
      current.close();
    }
  });

  it("lets renewal-first extend at equality and makes a stale takeover release lose", () => {
    const current = connection();
    try {
      seedAuthority(current);
      const leases = new SessionLeaseRepository();
      const first = leases.insertGeneration(current, acquire(1_000n, { leaseDurationMs: 120n }));
      const renewed = leases.renewCurrent(current, renew(first.expiresAtMs, {
        leaseDurationMs: 120n,
      }));
      assert.equal(renewed.lastObservedAtMs, 1_120n);
      assert.equal(renewed.expiresAtMs, 1_240n);
      expectCode(
        "EVENT_CONFLICT",
        () => leases.releaseCurrent(current, release(first, first.expiresAtMs)),
      );
      assert.equal(leases.current(current, PROJECT_ID, ROOT_ID)?.expiresAtMs, 1_240n);
    } finally {
      current.close();
    }
  });

  it("makes takeover-first fence the old renewal and carries clamped time into generation two", () => {
    const current = connection();
    try {
      seedAuthority(current);
      const leases = new SessionLeaseRepository();
      const first = leases.insertGeneration(current, acquire(1_000n, { leaseDurationMs: 120n }));
      leases.releaseCurrent(current, release(first, first.expiresAtMs));
      current.prepare(`
        UPDATE session_authority SET owner_generation = 2
        WHERE project_id = $projectId AND session_id = $sessionId
      `).run({ $projectId: PROJECT_ID, $sessionId: ROOT_ID });
      const second = leases.insertGeneration(current, acquire(900n, {
        ownerGeneration: 2n,
        ownerClientInstanceId: "primary-2",
        leaseDurationMs: 120n,
      }));
      assert.equal(second.lastObservedAtMs, first.expiresAtMs);
      assert.equal(second.expiresAtMs, first.expiresAtMs + 120n);
      expectCode("SESSION_HANDLE_STALE", () => leases.renewCurrent(current, renew(1_200n)));
    } finally {
      current.close();
    }
  });

  it("rejects stale generation/client renewals and releases", () => {
    const current = connection();
    try {
      seedAuthority(current);
      const leases = new SessionLeaseRepository();
      const lease = leases.insertGeneration(current, acquire(1_000n));
      expectCode("SESSION_HANDLE_STALE", () => leases.renewCurrent(current, renew(1_001n, {
        ownerGeneration: 2n,
      })));
      expectCode("SESSION_HANDLE_STALE", () => leases.renewCurrent(current, renew(1_001n, {
        ownerClientInstanceId: "primary-other",
      })));
      expectCode("EVENT_CONFLICT", () => leases.releaseCurrent(current, release(lease, 1_001n, {
        expectedExpiresAtMs: lease.expiresAtMs + 1n,
      })));
    } finally {
      current.close();
    }
  });

  it("rejects child and terminal-root leases and leaves migration triggers as the final guard", () => {
    const current = connection();
    try {
      seedAuthority(current, {
        sessionId: CHILD_ID,
        kind: "child",
        ownerGeneration: null,
      });
      expectCode("SESSION_STATE_CONFLICT", () => new SessionLeaseRepository().insertGeneration(
        current,
        acquire(1_000n, { sessionId: CHILD_ID }),
      ));

      seedAuthority(current, {
        sessionId: ROOT_ID,
        terminalEventPosition: 7n,
      });
      expectCode("SESSION_STATE_CONFLICT", () => new SessionLeaseRepository().insertGeneration(
        current,
        acquire(1_000n),
      ));

      assert.throws(() => current.prepare(`
        INSERT INTO session_leases(
          project_id, session_id, owner_generation, owner_client_instance_id,
          acquired_at, renewed_at, last_observed_at_ms, expires_at, released_at
        ) VALUES (
          $projectId, $sessionId, 1, 'child-1',
          '1970-01-01T00:00:01.000Z', '1970-01-01T00:00:01.000Z', 1000,
          '1970-01-01T00:00:02.000Z', NULL
        )
      `).run({ $projectId: PROJECT_ID, $sessionId: CHILD_ID }), /SESSION_LEASE_AUTHORITY_MISMATCH/);
    } finally {
      current.close();
    }
  });

  it("never begins, commits, rolls back, closes, waits, or opens on behalf of its caller", () => {
    const inner = connection();
    try {
      seedAuthority(inner);
      const guarded = new TransactionRejectingConnection(inner);
      const leases = new SessionLeaseRepository();
      const first = leases.insertGeneration(guarded, acquire(1_000n));
      assert.equal(leases.current(guarded, PROJECT_ID, ROOT_ID)?.ownerGeneration, 1n);
      const renewed = leases.renewCurrent(guarded, renew(1_001n));
      leases.releaseCurrent(guarded, release(renewed, 1_002n));
      assert.equal(leases.current(guarded, PROJECT_ID, ROOT_ID), null);
      assert.equal(guarded.execCalls, 0);
      assert.equal(guarded.closeCalls, 0);
      assert.equal(first.ownerGeneration, 1n);
    } finally {
      inner.close();
    }
  });
});
