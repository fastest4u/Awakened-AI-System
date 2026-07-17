import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ChildTransferRepository } from "../src/orchestrator/storage/child-transfer.repository.js";
import { LifecycleApprovalRepository } from "../src/orchestrator/storage/lifecycle-approval.repository.js";
import type {
  ApprovalConsumptionInput,
  ChildTransferClaim,
  ChildTransferTicketInsert,
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
const NEXT_ROOT_ID = "66666666-6666-4666-8666-666666666666";
const NEXT_CHILD_ID = "77777777-7777-4777-8777-777777777777";
const APPROVAL_ID = "88888888-8888-4888-8888-888888888888";
const COMMAND_ID = "99999999-9999-4999-8999-999999999999";
const TICKET_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CHECKPOINT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const HASH_A = "a".repeat(64);
const CONSUMED_AT_MS = 1_784_246_400_000n;
const CONSUMED_AT = "2026-07-17T00:00:00.000Z";
const MAX_CANONICAL_TIMESTAMP_MS = 253_402_300_799_999n;
const MAX_CANONICAL_TIMESTAMP = "9999-12-31T23:59:59.999Z";

type StatementKind = "run" | "get" | "all" | "iterate";
type Handler = (
  sql: string,
  kind: StatementKind,
  params: SqliteParams | undefined,
) => SqliteRunResult | SqliteRow | SqliteRow[] | undefined;

class RecordingConnection implements SqliteConnection {
  readonly prepared: string[] = [];
  readonly calls: Array<{
    readonly sql: string;
    readonly kind: StatementKind;
    readonly params: SqliteParams | undefined;
  }> = [];
  readonly execCalls: string[] = [];
  closeCalls = 0;

  constructor(private readonly handler: Handler) {}

  exec(sql: string): void {
    this.execCalls.push(sql);
    if (/\b(?:BEGIN|COMMIT|ROLLBACK)\b/iu.test(sql)) {
      throw new Error("NESTED_TRANSACTION_ATTEMPT");
    }
  }

  prepare(sql: string): SqliteStatement {
    this.prepared.push(sql);
    const invoke = (
      kind: StatementKind,
      params?: SqliteParams,
    ): SqliteRunResult | SqliteRow | SqliteRow[] | undefined => {
      this.calls.push({ sql, kind, params });
      return this.handler(sql, kind, params);
    };
    return {
      run: (params?: SqliteParams) => invoke("run", params) as SqliteRunResult,
      get: (params?: SqliteParams) => invoke("get", params) as SqliteRow | undefined,
      all: (params?: SqliteParams) => invoke("all", params) as SqliteRow[],
      iterate: (params?: SqliteParams) =>
        (invoke("iterate", params) as SqliteRow[])[Symbol.iterator](),
    };
  }

  close(): void {
    this.closeCalls += 1;
  }
}

function expectCode(code: string, action: () => unknown): void {
  assert.throws(action, (error: unknown) => (error as LifecycleError).code === code);
}

function approvalInput(): ApprovalConsumptionInput {
  return Object.freeze({
    approvalId: APPROVAL_ID,
    nonceDigest: HASH_A,
    projectId: PROJECT_ID,
    sessionId: ROOT_ID,
    action: "recover-root-authority",
    commandId: COMMAND_ID,
    targetActorRole: "primary",
    targetClientInstanceId: "primary-1",
    redactedApprovalReference: "approval/ticket-42",
    consumedEventPosition: 91n,
    consumedAtMs: CONSUMED_AT_MS,
  });
}

function transferInsert(): ChildTransferTicketInsert {
  return Object.freeze({
    projectId: PROJECT_ID,
    transferTicketId: TICKET_ID,
    sourceParentSessionId: ROOT_ID,
    sourceChildSessionId: CHILD_ID,
    sourceAssignment: Object.freeze({
      assignmentId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      summary: "carry the verified work",
    }),
    sourceScope: Object.freeze({ paths: Object.freeze(["src/"]) }),
    checkpointId: CHECKPOINT_ID,
    followUps: Object.freeze(["rerun focused verification"]),
    sourceState: Object.freeze({ fingerprint: HASH_A }),
    lineage: Object.freeze({ previousChildSessionId: CHILD_ID }),
    createdEventPosition: 41n,
    createdAtMs: CONSUMED_AT_MS,
  });
}

function transferClaim(): ChildTransferClaim {
  return Object.freeze({
    projectId: PROJECT_ID,
    transferTicketId: TICKET_ID,
    expectedCreatedEventPosition: 41n,
    claimedByRootSessionId: NEXT_ROOT_ID,
    claimedChildSessionId: NEXT_CHILD_ID,
    claimedEventPosition: 44n,
    claimedAtMs: CONSUMED_AT_MS,
  });
}

function claimedTicketRow(): SqliteRow {
  return {
    project_id: PROJECT_ID,
    transfer_ticket_id: TICKET_ID,
    source_parent_session_id: ROOT_ID,
    source_child_session_id: CHILD_ID,
    source_assignment_json: '{"assignmentId":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","summary":"carry the verified work"}',
    source_scope_json: '{"paths":["src/"]}',
    checkpoint_id: CHECKPOINT_ID,
    follow_ups_json: '["rerun focused verification"]',
    source_state_json: `{"fingerprint":"${HASH_A}"}`,
    lineage_json: `{"previousChildSessionId":"${CHILD_ID}"}`,
    created_event_position: 41n,
    created_at: CONSUMED_AT,
    claimed_by_root_session_id: NEXT_ROOT_ID,
    claimed_child_session_id: NEXT_CHILD_ID,
    claimed_event_position: 44n,
    claimed_at: CONSUMED_AT,
  };
}

describe("connection-bound lifecycle approval consumption", () => {
  it("persists the complete verified nonsecret tuple but never the redacted reference or raw approval", () => {
    let inserted: SqliteParams | undefined;
    const connection = new RecordingConnection((sql, kind, params) => {
      if (/SELECT 1(?: AS present)?\s+FROM lifecycle_approval_consumptions/iu.test(sql) && kind === "get") {
        return undefined;
      }
      if (/INSERT INTO lifecycle_approval_consumptions/iu.test(sql) && kind === "run") {
        inserted = params;
        return { changes: 1n, lastInsertRowid: 1n };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });

    new LifecycleApprovalRepository().consume(connection, approvalInput());

    assert.deepEqual(inserted, {
      $projectId: PROJECT_ID,
      $approvalId: APPROVAL_ID,
      $nonceDigest: HASH_A,
      $sessionId: ROOT_ID,
      $action: "recover-root-authority",
      $commandId: COMMAND_ID,
      $targetActorRole: "primary",
      $targetClientInstanceId: "primary-1",
      $consumedEventPosition: 91n,
      $consumedAt: CONSUMED_AT,
    });
    assert.equal(Object.hasOwn(inserted ?? {}, "$redactedApprovalReference"), false);
    assert.equal(connection.prepared.some((sql) => sql.includes("redactedApprovalReference")), false);
    assert.deepEqual(connection.execCalls, []);
    assert.equal(connection.closeCalls, 0);
  });

  it("rejects either approval-id or nonce reuse with the stable replay code", () => {
    const connection = new RecordingConnection((sql, kind) => {
      if (/SELECT 1(?: AS present)?\s+FROM lifecycle_approval_consumptions/iu.test(sql) && kind === "get") {
        return { present: 1n };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });
    expectCode(
      "LIFECYCLE_APPROVAL_REPLAYED",
      () => new LifecycleApprovalRepository().consume(connection, approvalInput()),
    );
  });

  it("strict-validates the bounded signed-claim reference without reading accessors", () => {
    let accessorReads = 0;
    const malicious = { ...approvalInput() } as Record<string, unknown>;
    Object.defineProperty(malicious, "redactedApprovalReference", {
      enumerable: true,
      get: () => {
        accessorReads += 1;
        return "approval/secret";
      },
    });
    const connection = new RecordingConnection(() => {
      throw new Error("SQL must not be reached");
    });
    expectCode(
      "LIFECYCLE_INPUT_INVALID",
      () => new LifecycleApprovalRepository().consume(
        connection,
        malicious as unknown as ApprovalConsumptionInput,
      ),
    );
    assert.equal(accessorReads, 0);

    expectCode(
      "LIFECYCLE_INPUT_INVALID",
      () => new LifecycleApprovalRepository().consume(connection, {
        ...approvalInput(),
        redactedApprovalReference: "x".repeat(513),
      }),
    );
  });

  it("accepts the last four-digit ISO instant and rejects the first expanded-year instant", () => {
    let inserted: SqliteParams | undefined;
    const connection = new RecordingConnection((sql, kind, params) => {
      if (kind === "get") return undefined;
      if (kind === "run" && /INSERT INTO lifecycle_approval_consumptions/iu.test(sql)) {
        inserted = params;
        return { changes: 1n, lastInsertRowid: 1n };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });
    const repository = new LifecycleApprovalRepository();
    repository.consume(connection, {
      ...approvalInput(),
      consumedAtMs: MAX_CANONICAL_TIMESTAMP_MS,
    });
    assert.equal(inserted?.$consumedAt, MAX_CANONICAL_TIMESTAMP);

    const rejecting = new RecordingConnection(() => {
      throw new Error("SQL must not be reached");
    });
    expectCode("LIFECYCLE_INPUT_INVALID", () => repository.consume(rejecting, {
      ...approvalInput(),
      consumedAtMs: MAX_CANONICAL_TIMESTAMP_MS + 1n,
    }));
    assert.equal(rejecting.prepared.length, 0);
  });
});

describe("immutable child transfer tickets", () => {
  it("inserts canonical ticket evidence and claims only the nullable claim group", () => {
    const runs: Array<{ readonly sql: string; readonly params: SqliteParams | undefined }> = [];
    const connection = new RecordingConnection((sql, kind, params) => {
      if (kind === "run") {
        runs.push({ sql, params });
        return { changes: 1n, lastInsertRowid: 1n };
      }
      if (kind === "get" && /FROM child_transfer_tickets/iu.test(sql)) {
        return claimedTicketRow();
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });
    const repository = new ChildTransferRepository();

    repository.insert(connection, transferInsert());
    const claimed = repository.claim(connection, transferClaim());

    assert.equal(claimed.claimedByRootSessionId, NEXT_ROOT_ID);
    assert.equal(claimed.claimedChildSessionId, NEXT_CHILD_ID);
    assert.equal(claimed.claimedEventPosition, 44n);
    assert.deepEqual(claimed.sourceScope, { paths: ["src/"] });
    const claimSql = runs[1]?.sql ?? "";
    assert.match(claimSql, /SET\s+claimed_by_root_session_id/iu);
    assert.doesNotMatch(claimSql, /SET[^]*source_(?:parent|child|assignment|scope|state)/iu);
    assert.match(claimSql, /created_event_position\s*=\s*\$expectedCreatedEventPosition/iu);
    assert.match(claimSql, /claimed_by_root_session_id\s+IS\s+NULL/iu);
    assert.match(claimSql, /claimed_child_session_id\s+IS\s+NULL/iu);
    assert.match(claimSql, /claimed_event_position\s+IS\s+NULL/iu);
    assert.match(claimSql, /claimed_at\s+IS\s+NULL/iu);
    assert.deepEqual(connection.execCalls, []);
    assert.equal(connection.closeCalls, 0);
  });

  it("returns EVENT_CONFLICT to every loser and preserves the source lineage", () => {
    const connection = new RecordingConnection((sql, kind) => {
      if (kind === "run" && /UPDATE child_transfer_tickets/iu.test(sql)) {
        return { changes: 0n, lastInsertRowid: 0n };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });
    expectCode(
      "EVENT_CONFLICT",
      () => new ChildTransferRepository().claim(connection, transferClaim()),
    );
  });

  it("keeps insert and claim timestamps within canonical four-digit ISO years", () => {
    let inserted: SqliteParams | undefined;
    const insertConnection = new RecordingConnection((_sql, kind, params) => {
      if (kind === "run") {
        inserted = params;
        return { changes: 1n, lastInsertRowid: 1n };
      }
      throw new Error("unexpected statement method");
    });
    const repository = new ChildTransferRepository();
    repository.insert(insertConnection, {
      ...transferInsert(),
      createdAtMs: MAX_CANONICAL_TIMESTAMP_MS,
    });
    assert.equal(inserted?.$createdAt, MAX_CANONICAL_TIMESTAMP);

    let claimed: SqliteParams | undefined;
    const claimConnection = new RecordingConnection((_sql, kind, params) => {
      if (kind === "run") {
        claimed = params;
        return { changes: 1n, lastInsertRowid: 0n };
      }
      if (kind === "get") {
        const row: SqliteRow = {
          ...claimedTicketRow(),
          claimed_at: MAX_CANONICAL_TIMESTAMP,
        };
        return row;
      }
      throw new Error("unexpected statement method");
    });
    repository.claim(claimConnection, {
      ...transferClaim(),
      claimedAtMs: MAX_CANONICAL_TIMESTAMP_MS,
    });
    assert.equal(claimed?.$claimedAt, MAX_CANONICAL_TIMESTAMP);

    const rejecting = new RecordingConnection(() => {
      throw new Error("SQL must not be reached");
    });
    expectCode("LIFECYCLE_INPUT_INVALID", () => repository.insert(rejecting, {
      ...transferInsert(),
      createdAtMs: MAX_CANONICAL_TIMESTAMP_MS + 1n,
    }));
    expectCode("LIFECYCLE_INPUT_INVALID", () => repository.claim(rejecting, {
      ...transferClaim(),
      claimedAtMs: MAX_CANONICAL_TIMESTAMP_MS + 1n,
    }));
    assert.equal(rejecting.prepared.length, 0);
  });
});
