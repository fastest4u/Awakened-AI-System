import { strict as assert } from "node:assert";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import {
  BoundSessionEndRepository,
  readPersistedValidationAttemptPlansV1,
  writePersistedValidationAttemptPlansV1,
} from "../src/orchestrator/storage/session-end.repository.js";
import type {
  SqliteConnection,
  SqliteParams,
  SqliteRow,
  SqliteRunResult,
  SqliteStatement,
} from "../src/orchestrator/storage/sqlite-driver.js";

class NativeStatement implements SqliteStatement {
  constructor(private readonly statement: import("node:sqlite").StatementSync) {
    statement.setReadBigInts(true);
  }
  run(params?: SqliteParams): SqliteRunResult {
    const result = params === undefined ? this.statement.run() : this.statement.run(params);
    return { changes: result.changes as bigint, lastInsertRowid: result.lastInsertRowid as bigint };
  }
  get(params?: SqliteParams): SqliteRow | undefined { return (params === undefined ? this.statement.get() : this.statement.get(params)) as SqliteRow | undefined; }
  all(params?: SqliteParams): SqliteRow[] { return (params === undefined ? this.statement.all() : this.statement.all(params)) as SqliteRow[]; }
  iterate(params?: SqliteParams): IterableIterator<SqliteRow> { return (params === undefined ? this.statement.iterate() : this.statement.iterate(params)) as IterableIterator<SqliteRow>; }
}

class NativeConnection implements SqliteConnection {
  readonly database = new DatabaseSync(":memory:");
  exec(sql: string): void { this.database.exec(sql); }
  prepare(sql: string): SqliteStatement { return new NativeStatement(this.database.prepare(sql)); }
  close(): void { this.database.close(); }
}

function planConnection(): NativeConnection {
  const connection = new NativeConnection();
  connection.exec(`CREATE TABLE workflow_instances (
    project_id TEXT NOT NULL, workflow_id TEXT NOT NULL, session_id TEXT NOT NULL,
    generation INTEGER NOT NULL, validation_attempt_plan_generation INTEGER,
    validation_attempt_plans_json TEXT, PRIMARY KEY(project_id, workflow_id)
  ) STRICT;
  INSERT INTO workflow_instances VALUES (
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333', 1, NULL, NULL
  );`);
  return connection;
}

const moduleUrl = new URL(
  "../src/orchestrator/storage/session-end.repository.js",
  import.meta.url,
).href;

function validPlans(): readonly Record<string, unknown>[] {
  return Object.freeze([Object.freeze({
    profileId: "alpha",
    profileVersion: 1,
    runId: "11111111-1111-4111-8111-111111111111",
    resultId: "22222222-2222-4222-8222-222222222222",
    commandId: "33333333-3333-4333-8333-333333333333",
    idempotencyKey: "validation/alpha",
  })]);
}

function planAtCanonicalByteLength(length: number): readonly Record<string, unknown>[] {
  const seed = { ...validPlans()[0]!, profileId: "" };
  const fixed = Buffer.byteLength(JSON.stringify([seed]), "utf8");
  return Object.freeze([Object.freeze({ ...seed, profileId: "x".repeat(length - fixed) })]);
}

it("strictly decodes the six-key persisted validation plan and rejects ordering identity cap violations", async () => {
  const repository = await (new Function("url", "return import(url)") as (
    url: string,
  ) => Promise<Record<string, unknown>>)(moduleUrl);
  const decode = repository.decodePersistedValidationPlansV1;
  assert.equal(typeof decode, "function");
  assert.deepEqual(Reflect.apply(decode as Function, undefined, [validPlans()]), validPlans());
  for (const hostile of [
    [],
    [{ ...validPlans()[0]!, profileId: "z" }, { ...validPlans()[0]!, profileId: "a", profileVersion: 2, runId: "44444444-4444-4444-8444-444444444444", resultId: "55555555-5555-4555-8555-555555555555", commandId: "66666666-6666-4666-8666-666666666666", idempotencyKey: "validation/a" }],
    [{ ...validPlans()[0]!, profileConfigurationHash: "must-not-persist" }],
    [validPlans()[0]!, { ...validPlans()[0]!, commandId: "66666666-6666-4666-8666-666666666666", resultId: "55555555-5555-4555-8555-555555555555", runId: "44444444-4444-4444-8444-444444444444", idempotencyKey: "validation/alpha-duplicate" }],
    [validPlans()[0]!, { ...validPlans()[0]!, profileId: "beta", commandId: "66666666-6666-4666-8666-666666666666", resultId: "55555555-5555-4555-8555-555555555555", idempotencyKey: "validation/beta" }],
    planAtCanonicalByteLength(262_145),
    Array.from({ length: 65 }, (_, index) => ({ ...validPlans()[0]!, profileId: `profile-${index.toString().padStart(2, "0")}`, runId: `${index.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`, resultId: `${index.toString(16).padStart(8, "0")}-2222-4222-8222-222222222222`, commandId: `${index.toString(16).padStart(8, "0")}-3333-4333-8333-333333333333`, idempotencyKey: `validation/${index}` })),
  ]) {
    assert.throws(() => Reflect.apply(decode as Function, undefined, [hostile]), (error: unknown) => (
      typeof error === "object" && error !== null && "code" in error
        && (error as { code?: unknown }).code === "INTEGRITY_FAILURE"
    ));
  }
  assert.deepEqual(
    Reflect.apply(decode as Function, undefined, [planAtCanonicalByteLength(262_144)]),
    planAtCanonicalByteLength(262_144),
  );
});

it("stores six-key plans once through connection and bound facades", () => {
  const connection = planConnection();
  const input = {
    projectId: "11111111-1111-4111-8111-111111111111",
    workflowId: "22222222-2222-4222-8222-222222222222",
    workflowGeneration: 1,
    plans: validPlans(),
  };
  writePersistedValidationAttemptPlansV1(connection, input);
  assert.deepEqual(readPersistedValidationAttemptPlansV1(connection, input.projectId, input.workflowId), {
    workflowGeneration: 1,
    plans: validPlans(),
  });
  assert.throws(() => new BoundSessionEndRepository(connection)
    .writePersistedValidationAttemptPlansV1(input));
  connection.close();
});
