import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { ShadowMigrationError } from "../src/orchestrator/migration/v2-shadow-migration.contracts.js";
import { createCompatibilityFixture } from "./support/v2-shadow-migration-fixture.js";
import { createHash } from "node:crypto";
import { deterministicMigrationUuid } from "../src/orchestrator/migration/v2-shadow-migration.contracts.js";
import type { SqliteConnection } from "../src/orchestrator/storage/sqlite-driver.js";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { applyCurrentProjectStoreSchema } from "./support/current-project-store-schema.js";
import { createShadowMigrationInvocationDeadline } from "../src/orchestrator/migration/v2-shadow-migration-runtime.js";
import { StableCompatibilityDirectory } from "../src/orchestrator/materialization/stable-compatibility-directory.js";
import { V2ImportedProjectionEventReader } from "../src/orchestrator/migration/v2-imported-event-reader.js";

const codeIs = (code: string) => (error: unknown) => error instanceof ShadowMigrationError && error.code === code;
const ledger = (f: Awaited<ReturnType<typeof createCompatibilityFixture>>) => f.repository.transact(
  f.projectionBinding.projectId, f.sealedPackage.migrationIdentity, tx => ({ run: tx.readRun(), receipts: tx.readImportedRecords(),
    outbox: tx.readCompatibilityOutbox(), claims: tx.readCompatibilityClaims(), acks: tx.readCompatibilityAcknowledgements() }));
function tree(path: string): unknown {
  const stat = lstatSync(path, { bigint: true });
  return { inode: stat.ino, bytes: stat.isDirectory() ? readdirSync(path).sort().map(name => [name, tree(join(path, name))])
    : createHash("sha256").update(readFileSync(path)).digest("hex") };
}

test("Task11E exhausted shared budget refuses all new claims", async t => {
  const { V2ShadowCompatibilityMaterializer } = await import(moduleUrl), f = await createCompatibilityFixture(t);
  let time = 0; const deadline = createShadowMigrationInvocationDeadline(30000, () => time);
  const before = ledger(f); time = 30000;
  try { await assert.rejects(new V2ShadowCompatibilityMaterializer(f.materializerOptions).materializePending({ ...f.input,
    invocationDeadline: deadline }), codeIs("MIGRATION_RETRY_EXHAUSTED")); }
  finally { deadline.dispose(); }
  assert.deepEqual(ledger(f), before); assert.deepEqual(readdirSync(f.isolatedRoot), []);
});

test("Task11E proves absent and zero committed without semantic writes or parent preparation", async t => {
  for (const legacyArtifacts of [true, false]) await t.test(String(legacyArtifacts), async child => {
    const { V2ShadowCompatibilityMaterializer } = await import(moduleUrl);
    let armed = false, writes = 0;
    class ReadObserver extends DatabaseSync {
      override prepare(sql: string): StatementSync { if (armed && /^(INSERT|UPDATE|DELETE)/i.test(sql)) { writes++; throw new Error("proof write"); } return super.prepare(sql); }
    }
    const f = await createCompatibilityFixture(child, { legacyArtifacts, database: ReadObserver });
    const before = ledger(f), protectedBefore = [tree(f.source.sourceRoot), tree(f.sealedPackage.rootPath), tree(f.liveVaultRoot)];
    const original = StableCompatibilityDirectory.prototype.prepareParent; let prepares = 0;
    StableCompatibilityDirectory.prototype.prepareParent = async function (...args) { prepares++; return original.apply(this, args); };
    armed = true;
    try {
      const materializer = new V2ShadowCompatibilityMaterializer(f.materializerOptions);
      assert.equal(typeof materializer.reconcile, "function");
      const result = await materializer.reconcile(f.input); assert.ok(Object.isFrozen(result));
      if (legacyArtifacts) assert.deepEqual(result, { status: "absent" });
      else {
        assert.equal(result.status, "committed"); assert.ok(Object.isFrozen(result.result));
        assert.equal(result.result.acknowledgedCount, 0); assert.equal(result.result.aggregateBytes, 0);
        assert.equal(result.result.highestAcknowledgedSourceOrdinal, null); assert.equal(result.result.acknowledgedImportedPosition, null);
        assert.equal(result.result.materializationRevision, null); assert.equal(result.result.deduplicated, true);
        assert.equal(result.result.artifactSetChecksum, "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945");
      }
    } finally { armed = false; StableCompatibilityDirectory.prototype.prepareParent = original; }
    assert.equal(writes, 0); assert.equal(prepares, 0); assert.deepEqual(ledger(f), before);
    assert.deepEqual(readdirSync(f.isolatedRoot), []); assert.deepEqual([tree(f.source.sourceRoot), tree(f.sealedPackage.rootPath), tree(f.liveVaultRoot)], protectedBefore);
  });
});

test("Task11E actual replace and committed acknowledgement faults reconcile without duplicate ack or rewrite", async t => {
  for (const boundary of ["after-compatibility-replace", "after-compatibility-ack"] as const) await t.test(boundary, async child => {
    const { V2ShadowCompatibilityMaterializer } = await import(moduleUrl), f = await createCompatibilityFixture(child);
    let reached = 0;
    const materializer = new V2ShadowCompatibilityMaterializer({ ...f.materializerOptions, fault: (point: string) => {
      if (point !== boundary) return; reached++;
      assert.equal(readFileSync(join(f.isolatedRoot, "legacy/one.md"), "utf8"), "# Decision\nKeep V1 authoritative.\n");
      assert.equal(ledger(f).acks.length, boundary === "after-compatibility-ack" ? 1 : 0);
      throw new Error("lost acknowledgement response");
    } });
    await assert.rejects(materializer.materializePending(f.input), codeIs("MIGRATION_OUTCOME_UNKNOWN")); assert.equal(reached, 1);
    const before = ledger(f), targetBefore = tree(f.isolatedRoot);
    const clean = new V2ShadowCompatibilityMaterializer(f.materializerOptions);
    assert.deepEqual(await clean.reconcile(f.input), { status: "unknown", safeErrorCode: "MIGRATION_OUTCOME_UNKNOWN" });
    assert.deepEqual(ledger(f), before); assert.deepEqual(tree(f.isolatedRoot), targetBefore);
    const inode = lstatSync(join(f.isolatedRoot, "legacy/one.md"), { bigint: true }).ino;
    const completed = await clean.materializePending(f.input);
    assert.equal(ledger(f).acks.length, 2); assert.equal(lstatSync(join(f.isolatedRoot, "legacy/one.md"), { bigint: true }).ino, inode);
    const committedBefore = ledger(f), bytesBefore = tree(f.isolatedRoot);
    assert.deepEqual(await clean.reconcile(f.input), { status: "committed", result: { ...completed, deduplicated: true } });
    assert.deepEqual(ledger(f), committedBefore); assert.deepEqual(tree(f.isolatedRoot), bytesBefore);
  });
});

test("Task11E complete acknowledgements preserve terminal missing and contradictory target failures", async t => {
  for (const variant of ["missing", "contradictory"] as const) await t.test(variant, async child => {
    const { V2ShadowCompatibilityMaterializer } = await import(moduleUrl), f = await createCompatibilityFixture(child);
    const materializer = new V2ShadowCompatibilityMaterializer(f.materializerOptions);
    await materializer.materializePending(f.input);
    const target = join(f.isolatedRoot, "legacy/one.md"); unlinkSync(target);
    if (variant === "contradictory") renameSync(join(f.isolatedRoot, "legacy/two.md"), target);
    const before = ledger(f), files = tree(f.isolatedRoot);
    assert.equal(typeof materializer.reconcile, "function");
    await assert.rejects(materializer.reconcile(f.input), codeIs("COMPATIBILITY_INTEGRITY_FAILURE"));
    assert.deepEqual(ledger(f), before); assert.deepEqual(tree(f.isolatedRoot), files);
  });
});

test("Task11E snapshot expiry closes acquired resources and preserves the primary deadline over cleanup failure", async t => {
  const { V2ShadowCompatibilityMaterializer } = await import(moduleUrl), f = await createCompatibilityFixture(t);
  let time = 0, closed = 0; const deadline = createShadowMigrationInvocationDeadline(30000, () => time);
  const original = V2ImportedProjectionEventReader.prototype.openCommittedSnapshot;
  V2ImportedProjectionEventReader.prototype.openCommittedSnapshot = async function (...args) {
    const snapshot = await original.apply(this, args); time = 30000;
    return { ...snapshot, close() { snapshot.close(); closed++; throw new Error("cleanup failure must not erase deadline"); } };
  };
  const before = ledger(f);
  try { await assert.rejects(new V2ShadowCompatibilityMaterializer(f.materializerOptions).materializePending({ ...f.input,
    invocationDeadline: deadline }), codeIs("MIGRATION_RETRY_EXHAUSTED")); }
  finally { deadline.dispose(); V2ImportedProjectionEventReader.prototype.openCommittedSnapshot = original; }
  assert.equal(closed, 1); assert.deepEqual(ledger(f), before); assert.deepEqual(readdirSync(f.isolatedRoot), []);
});

test("Task11E refuses replaced isolated root after awaited source proof even for absent artifacts", async t => {
  const { V2ShadowCompatibilityMaterializer } = await import(moduleUrl), f = await createCompatibilityFixture(t);
  const original = V2ImportedProjectionEventReader.prototype.openCommittedSnapshot; let swapped = false;
  V2ImportedProjectionEventReader.prototype.openCommittedSnapshot = async function (...args) {
    const snapshot = await original.apply(this, args);
    renameSync(f.isolatedRoot, `${f.isolatedRoot}-retained`); mkdirSync(f.isolatedRoot); swapped = true;
    return snapshot;
  };
  const before = ledger(f);
  try { await assert.rejects(new V2ShadowCompatibilityMaterializer(f.materializerOptions).reconcile(f.input), codeIs("COMPATIBILITY_INTEGRITY_FAILURE")); }
  finally { V2ImportedProjectionEventReader.prototype.openCommittedSnapshot = original; }
  assert.equal(swapped, true); assert.deepEqual(ledger(f), before); assert.deepEqual(readdirSync(f.isolatedRoot), []);
});

test("Task11E read failure cannot prove absence and partial claims never invoke target verification", async t => {
  let armed = false, reads = 0;
  class FailedRead extends DatabaseSync {
    override prepare(sql: string): StatementSync {
      if (armed && sql.startsWith("SELECT * FROM v2_shadow_compatibility_claims")) { reads++; throw new Error("unobservable read"); }
      return super.prepare(sql);
    }
  }
  const { V2ShadowCompatibilityMaterializer } = await import(moduleUrl), f = await createCompatibilityFixture(t, { database: FailedRead });
  const materializer = new V2ShadowCompatibilityMaterializer(f.materializerOptions), before = ledger(f);
  armed = true;
  try { assert.deepEqual(await materializer.reconcile(f.input), { status: "unknown", safeErrorCode: "MIGRATION_OUTCOME_UNKNOWN" }); }
  finally { armed = false; }
  assert.equal(reads, 1); assert.deepEqual(ledger(f), before);
  let claims = 0;
  const migration = f.sealedPackage.migrationIdentity, id = deterministicMigrationUuid("claim", migration, 2);
  f.repository.transact(f.projectionBinding.projectId, migration, tx => tx.claimCompatibility({ projectId: f.projectionBinding.projectId,
    migrationIdentity: migration, outboxId: id, claimId: id,
    claimOwnerFingerprint: createHash("sha256").update(`project-memory/v2-shadow-compatibility-owner/v1\n${migration}`).digest("hex"), claimedAt: "2026-09-10T00:00:00.002Z" }));
  const original = StableCompatibilityDirectory.prototype.verifyOnly;
  StableCompatibilityDirectory.prototype.verifyOnly = async function (...args) { claims++; return original.apply(this, args); };
  const claimed = ledger(f);
  try { assert.deepEqual(await materializer.reconcile(f.input), { status: "unknown", safeErrorCode: "MIGRATION_OUTCOME_UNKNOWN" }); }
  finally { StableCompatibilityDirectory.prototype.verifyOnly = original; }
  assert.equal(claims, 0); assert.deepEqual(ledger(f), claimed); assert.deepEqual(readdirSync(f.isolatedRoot), []);
});

test("Task11E expiry after each committed ack remains unknown and no-op expiry remains retry exhausted", async t => {
  for (const at of [1, 2]) await t.test(`ack-${at}`, async child => {
    const { V2ShadowCompatibilityMaterializer } = await import(moduleUrl), f = await createCompatibilityFixture(child);
    let time = 0, acks = 0; const deadline = createShadowMigrationInvocationDeadline(30000, () => time);
    try { await assert.rejects(new V2ShadowCompatibilityMaterializer({ ...f.materializerOptions, fault: (point: string) => {
      if (point === "after-compatibility-ack" && ++acks === at) time = 30000;
    } }).materializePending({ ...f.input, invocationDeadline: deadline }), codeIs("MIGRATION_OUTCOME_UNKNOWN")); }
    finally { deadline.dispose(); }
    assert.equal(acks, at); assert.equal(ledger(f).acks.length, at); assert.equal(ledger(f).claims.length, at);
    const clean = new V2ShadowCompatibilityMaterializer(f.materializerOptions); await clean.materializePending(f.input);
    const before = ledger(f), targets = tree(f.isolatedRoot); let verified = 0; time = 0;
    const noopDeadline = createShadowMigrationInvocationDeadline(30000, () => time), original = StableCompatibilityDirectory.prototype.verifyOnly;
    StableCompatibilityDirectory.prototype.verifyOnly = async function (...args) {
      const result = await original.apply(this, args); if (++verified === 2) time = 30000; return result;
    };
    try { await assert.rejects(clean.materializePending({ ...f.input, invocationDeadline: noopDeadline }), codeIs("MIGRATION_RETRY_EXHAUSTED")); }
    finally { noopDeadline.dispose(); StableCompatibilityDirectory.prototype.verifyOnly = original; }
    assert.equal(verified, 2); assert.deepEqual(ledger(f), before); assert.deepEqual(tree(f.isolatedRoot), targets);
  });
});

test("Task11E samples child and imported-reader timeouts after prior transactions and awaits and zeroes payload bytes", async t => {
  let armed = false, time = 0, commits = 0;
  class TimedCommit extends DatabaseSync {
    override exec(sql: string): void { super.exec(sql); if (armed && sql === "COMMIT") { time += 500; commits++; } }
  }
  const { V2ShadowCompatibilityMaterializer } = await import(moduleUrl), f = await createCompatibilityFixture(t, { database: TimedCommit });
  const deadline = createShadowMigrationInvocationDeadline(30000, () => time), native: number[] = [], payloads: Uint8Array[] = [];
  const prepare = StableCompatibilityDirectory.prototype.prepareParent, publish = StableCompatibilityDirectory.prototype.publishOrReconcile;
  const verify = StableCompatibilityDirectory.prototype.verifyOnly; let verified = 0;
  const opens: number[] = [], driver = { ...f.driver, open: f.driver.open.bind(f.driver) };
  driver.open = (path, options) => { if (armed) opens.push(options.busyTimeoutMs); return f.driver.open(path, options); };
  StableCompatibilityDirectory.prototype.prepareParent = async function (path, remainingMs) {
    assert.equal(remainingMs, 30000 - time); native.push(remainingMs);
    const result = await prepare.call(this, path, remainingMs); time += 700; return result;
  };
  StableCompatibilityDirectory.prototype.publishOrReconcile = async function (input) {
    assert.equal(input.remainingMs, 30000 - time); native.push(input.remainingMs); payloads.push(input.bytes);
    const result = await publish.call(this, input); time += 300; return result;
  };
  StableCompatibilityDirectory.prototype.verifyOnly = async function (input) {
    assert.equal(input.remainingMs, 30000 - time); verified++;
    const result = await verify.call(this, input); time += 200; return result;
  };
  armed = true;
  try { const materializer = new V2ShadowCompatibilityMaterializer({ ...f.materializerOptions, driver });
    const result = await materializer.materializePending({ ...f.input, invocationDeadline: deadline }); assert.equal(result.acknowledgedCount, 2);
    const noOp = await materializer.materializePending({ ...f.input, invocationDeadline: deadline }); assert.equal(noOp.deduplicated, true);
  }
  finally { armed = false; deadline.dispose(); StableCompatibilityDirectory.prototype.prepareParent = prepare;
    StableCompatibilityDirectory.prototype.publishOrReconcile = publish; StableCompatibilityDirectory.prototype.verifyOnly = verify; }
  assert.equal(verified, 2);
  assert.ok(commits >= 5); assert.equal(native.length, 4); assert.ok(native[1]! < native[0]!); assert.ok(opens.length >= 2);
  assert.ok(opens.every(value => value > 0 && value <= 5000)); assert.equal(payloads.length, 2);
  for (const bytes of payloads) assert.ok(bytes.every(value => value === 0));
});

test("Task11E expiry inside an actual claim transaction rolls back without inventing a durable mutation", async t => {
  let armed = false, time = 0, inserted = 0;
  class ExpireClaim extends DatabaseSync {
    override prepare(sql: string): StatementSync {
      const statement = super.prepare(sql);
      if (armed && sql.startsWith("INSERT INTO v2_shadow_compatibility_claims")) {
        const run = statement.run.bind(statement);
        statement.run = ((...args: Parameters<typeof run>) => { const result = run(...args); inserted++; time = 30000; return result; }) as typeof statement.run;
      }
      return statement;
    }
  }
  const { V2ShadowCompatibilityMaterializer } = await import(moduleUrl), f = await createCompatibilityFixture(t, { database: ExpireClaim });
  const deadline = createShadowMigrationInvocationDeadline(30000, () => time), before = ledger(f); armed = true;
  try { await assert.rejects(new V2ShadowCompatibilityMaterializer(f.materializerOptions).materializePending({ ...f.input,
    invocationDeadline: deadline }), codeIs("MIGRATION_RETRY_EXHAUSTED")); }
  finally { armed = false; deadline.dispose(); }
  assert.equal(inserted, 1); assert.deepEqual(ledger(f), before); assert.deepEqual(readdirSync(f.isolatedRoot), []);
});

test("Task11E imported reads use the remainder consumed by a real transaction and proof expiry cannot become absence", async t => {
  let armed = false, time = 0, commits = 0;
  class LateCommit extends DatabaseSync {
    override exec(sql: string): void { super.exec(sql); if (armed && sql === "COMMIT") { commits++; time = 27000; } }
  }
  const { V2ShadowCompatibilityMaterializer } = await import(moduleUrl), f = await createCompatibilityFixture(t, { database: LateCommit });
  const before = ledger(f), deadline = createShadowMigrationInvocationDeadline(30000, () => time), opens: number[] = [];
  const driver = { open: (path: Parameters<typeof f.driver.open>[0], options: Parameters<typeof f.driver.open>[1]) => {
    opens.push(options.busyTimeoutMs); assert.equal(options.busyTimeoutMs, 3000); return f.driver.open(path, options);
  } };
  armed = true;
  try { assert.deepEqual(await new V2ShadowCompatibilityMaterializer({ ...f.materializerOptions, driver }).reconcile({ ...f.input,
    invocationDeadline: deadline }), { status: "absent" }); }
  finally { armed = false; deadline.dispose(); }
  assert.ok(commits >= 2); assert.equal(opens.length, 2); assert.deepEqual(ledger(f), before);
  const expired = createShadowMigrationInvocationDeadline(30000, () => time); time += 30000;
  try { await assert.rejects(new V2ShadowCompatibilityMaterializer(f.materializerOptions).reconcile({ ...f.input, invocationDeadline: expired }),
    codeIs("MIGRATION_RETRY_EXHAUSTED")); }
  finally { expired.dispose(); }
  assert.deepEqual(ledger(f), before); assert.deepEqual(readdirSync(f.isolatedRoot), []);
});

test("Task11E settles native preparation then refuses expired publication without abandoning work", async t => {
  const { V2ShadowCompatibilityMaterializer } = await import(moduleUrl), f = await createCompatibilityFixture(t);
  let time = 0, prepared = 0, published = 0; const deadline = createShadowMigrationInvocationDeadline(30000, () => time);
  const prepare = StableCompatibilityDirectory.prototype.prepareParent, publish = StableCompatibilityDirectory.prototype.publishOrReconcile;
  StableCompatibilityDirectory.prototype.prepareParent = async function (...args) { const result = await prepare.apply(this, args); prepared++; time = 30000; return result; };
  StableCompatibilityDirectory.prototype.publishOrReconcile = async function (...args) { published++; return publish.apply(this, args); };
  try { await assert.rejects(new V2ShadowCompatibilityMaterializer(f.materializerOptions).materializePending({ ...f.input, invocationDeadline: deadline }),
    codeIs("MIGRATION_OUTCOME_UNKNOWN")); }
  finally { deadline.dispose(); StableCompatibilityDirectory.prototype.prepareParent = prepare; StableCompatibilityDirectory.prototype.publishOrReconcile = publish; }
  assert.equal(prepared, 1); assert.equal(published, 0); assert.equal(ledger(f).claims.length, 1); assert.equal(ledger(f).acks.length, 0);
  assert.deepEqual(readdirSync(join(f.isolatedRoot, "legacy")), []);
});

test("Task11E proof authenticates zero and nonzero run receipt event claim and ack evidence", async t => {
  for (const variant of ["zero-run", "zero-receipt", "event", "claim", "ack"] as const) await t.test(variant, async child => {
    const { V2ShadowCompatibilityMaterializer } = await import(moduleUrl), f = await createCompatibilityFixture(child, { legacyArtifacts: !variant.startsWith("zero") });
    const materializer = new V2ShadowCompatibilityMaterializer(f.materializerOptions);
    if (variant === "ack") await materializer.materializePending(f.input);
    if (variant === "claim") {
      await assert.rejects(new V2ShadowCompatibilityMaterializer({ ...f.materializerOptions, fault: () => { throw new Error("boundary"); } }).materializePending(f.input));
    }
    const table = variant === "zero-run" ? "v2_shadow_migration_runs" : variant === "zero-receipt" ? "v2_shadow_imported_records"
      : variant === "event" ? "events" : variant === "claim" ? "v2_shadow_compatibility_claims" : "v2_shadow_compatibility_acknowledgements";
    for (const row of f.connection.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name=$t").all({ $t: table })) {
      f.connection.exec(`DROP TRIGGER "${String(row.name).replace(/"/g, '""')}"`);
    }
    const update = variant === "zero-run" ? "build_identity_hash='ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'"
      : variant === "zero-receipt" ? "recorded_at='2026-09-10T00:00:01.000Z'"
      : variant === "event" ? "actor_role='maintenance'"
      : variant === "claim" ? "claimed_at='2026-09-10T00:00:01.000Z'" : "acknowledged_at='2026-09-10T00:00:01.000Z'";
    f.connection.exec(`UPDATE ${table} SET ${update}`);
    const rows = f.connection.prepare(`SELECT * FROM ${table}`).all(), targets = tree(f.isolatedRoot);
    await assert.rejects(materializer.reconcile(f.input), (error: unknown) => error instanceof ShadowMigrationError
      && ["COMPATIBILITY_INTEGRITY_FAILURE", "MIGRATION_LEDGER_INTEGRITY_FAILURE", "PROJECTION_INTEGRITY_FAILURE"].includes(error.code));
    assert.deepEqual(f.connection.prepare(`SELECT * FROM ${table}`).all(), rows); assert.deepEqual(tree(f.isolatedRoot), targets);
  });
});

test("Task11E unobservable target response remains unknown and unknown typed codes are redacted", async t => {
  const { V2ShadowCompatibilityMaterializer } = await import(moduleUrl), f = await createCompatibilityFixture(t);
  const materializer = new V2ShadowCompatibilityMaterializer(f.materializerOptions); await materializer.materializePending(f.input);
  const before = ledger(f), targets = tree(f.isolatedRoot), original = StableCompatibilityDirectory.prototype.verifyOnly;
  for (const kind of ["transient", "unallowlisted"] as const) {
    let verified = 0;
    StableCompatibilityDirectory.prototype.verifyOnly = async function (...args) {
      await original.apply(this, args); verified++;
      throw kind === "transient" ? new ShadowMigrationError("MIGRATION_OUTCOME_UNKNOWN") : new ShadowMigrationError("secret-code" as never);
    };
    try { assert.deepEqual(await materializer.reconcile(f.input), { status: "unknown", safeErrorCode: "MIGRATION_OUTCOME_UNKNOWN" }); }
    finally { StableCompatibilityDirectory.prototype.verifyOnly = original; }
    assert.equal(verified, 1); assert.deepEqual(ledger(f), before); assert.deepEqual(tree(f.isolatedRoot), targets);
  }
});

test("Task11E cooperatively stops an actual eager evidence traversal before visiting another receipt", async t => {
  const { V2ShadowCompatibilityMaterializer } = await import(moduleUrl), f = await createCompatibilityFixture(t);
  const before = ledger(f), entries = Object.entries; let time = 0, visited = 0;
  const deadline = createShadowMigrationInvocationDeadline(30000, () => time);
  Object.entries = ((value: object) => {
    const result = entries(value);
    if (Object.hasOwn(value, "sourceKind") && Object.hasOwn(value, "importedGlobalPosition")) { visited++; time = 30000; }
    return result;
  }) as typeof Object.entries;
  try { await assert.rejects(new V2ShadowCompatibilityMaterializer(f.materializerOptions).materializePending({ ...f.input, invocationDeadline: deadline }),
    codeIs("MIGRATION_RETRY_EXHAUSTED")); }
  finally { Object.entries = entries; deadline.dispose(); }
  assert.equal(visited, 1); assert.deepEqual(ledger(f), before); assert.deepEqual(readdirSync(f.isolatedRoot), []);
});

test("Task11E replay cleanup preserves callback expiry after real iteration and real close", async t => {
  const { V2ShadowCompatibilityMaterializer } = await import(moduleUrl), f = await createCompatibilityFixture(t);
  let time = 0, opens = 0, visited = 0, closed = 0;
  const deadline = createShadowMigrationInvocationDeadline(30000, () => time), before = ledger(f);
  const driver = { open: (path: Parameters<typeof f.driver.open>[0], options: Parameters<typeof f.driver.open>[1]) => {
    const connection = f.driver.open(path, options);
    if (++opens !== 2) return connection;
    const prepare = connection.prepare.bind(connection), close = connection.close.bind(connection);
    connection.prepare = sql => {
      const statement = prepare(sql), iterate = statement.iterate.bind(statement);
      statement.iterate = function* (params) {
        for (const row of iterate(params)) { visited++; time = 30000; yield row; }
      };
      return statement;
    };
    connection.close = () => { close(); closed++; throw new Error("secondary replay close failure"); };
    return connection;
  } };
  try { await assert.rejects(new V2ShadowCompatibilityMaterializer({ ...f.materializerOptions, driver }).materializePending({ ...f.input,
    invocationDeadline: deadline }), codeIs("MIGRATION_RETRY_EXHAUSTED")); }
  finally { deadline.dispose(); }
  assert.equal(opens, 2); assert.equal(visited, 1); assert.equal(closed, 1);
  assert.deepEqual(ledger(f), before); assert.deepEqual(readdirSync(f.isolatedRoot), []);
});

const moduleUrl = new URL("../src/orchestrator/materialization/v2-shadow-compatibility.materializer.js", import.meta.url).href;
test("Task11E fix1 native rejection distinguishes retained expiry from read uncertainty on old evidence", async t => {
  for (const method of ["materializePending", "reconcile"] as const) await t.test(method, async child => {
    const { V2ShadowCompatibilityMaterializer } = await import(moduleUrl), f = await createCompatibilityFixture(child);
    const materializer = new V2ShadowCompatibilityMaterializer({ ...f.materializerOptions, operationNow: () => 0 });
    await materializer.materializePending(f.input);
    const before = ledger(f), protectedBefore = [tree(f.isolatedRoot), tree(f.source.sourceRoot), tree(f.sealedPackage.rootPath), tree(f.liveVaultRoot)];
    for (const variant of ["live-budget", "expired-retained-budget", "terminal-integrity", "no-deadline"] as const) await child.test(variant, async () => {
      let time = 0, settled = 0;
      const deadline = variant === "no-deadline" ? undefined : createShadowMigrationInvocationDeadline(30000, () => time);
      let replacement: ReturnType<typeof createShadowMigrationInvocationDeadline> | undefined;
      const input = { ...f.input, invocationDeadline: deadline }, original = StableCompatibilityDirectory.prototype.verifyOnly;
      StableCompatibilityDirectory.prototype.verifyOnly = async function (...args) {
        await original.apply(this, args); settled++;
        if (variant === "expired-retained-budget" || variant === "terminal-integrity") time = 30000;
        if (variant === "expired-retained-budget") {
          replacement = createShadowMigrationInvocationDeadline(30000, () => 0); input.invocationDeadline = replacement;
        }
        // Simulated lost/failed response after real native settlement, not an actual native timer firing.
        throw new ShadowMigrationError(variant === "terminal-integrity" ? "COMPATIBILITY_INTEGRITY_FAILURE" : "MIGRATION_OUTCOME_UNKNOWN");
      };
      try {
        if (method === "reconcile" && (variant === "live-budget" || variant === "no-deadline")) {
          assert.deepEqual(await materializer[method](input), { status: "unknown", safeErrorCode: "MIGRATION_OUTCOME_UNKNOWN" });
        } else await assert.rejects(materializer[method](input), codeIs(variant === "expired-retained-budget" ? "MIGRATION_RETRY_EXHAUSTED"
          : variant === "terminal-integrity" ? "COMPATIBILITY_INTEGRITY_FAILURE" : "MIGRATION_OUTCOME_UNKNOWN"));
      } finally { StableCompatibilityDirectory.prototype.verifyOnly = original; deadline?.dispose(); replacement?.dispose(); }
      assert.equal(settled, 1); assert.deepEqual(ledger(f), before); f.source.assertUnchanged(); f.sealedPackage.assertUnchanged();
      assert.deepEqual([tree(f.isolatedRoot), tree(f.source.sourceRoot), tree(f.sealedPackage.rootPath), tree(f.liveVaultRoot)], protectedBefore);
    });
  });
});

test("Task11E fix1 rejected native publication after a possible mutation remains unknown on expiry", async t => {
  const { V2ShadowCompatibilityMaterializer } = await import(moduleUrl), f = await createCompatibilityFixture(t);
  let time = 0, settled = 0; const deadline = createShadowMigrationInvocationDeadline(30000, () => time);
  const original = StableCompatibilityDirectory.prototype.publishOrReconcile;
  const protectedBefore = [tree(f.source.sourceRoot), tree(f.sealedPackage.rootPath), tree(f.liveVaultRoot)];
  StableCompatibilityDirectory.prototype.publishOrReconcile = async function (...args) {
    await original.apply(this, args); settled++; time = 30000; throw new ShadowMigrationError("MIGRATION_OUTCOME_UNKNOWN");
  };
  try { await assert.rejects(new V2ShadowCompatibilityMaterializer(f.materializerOptions).materializePending({ ...f.input,
    invocationDeadline: deadline }), codeIs("MIGRATION_OUTCOME_UNKNOWN")); }
  finally { StableCompatibilityDirectory.prototype.publishOrReconcile = original; deadline.dispose(); }
  assert.equal(settled, 1); const evidence = ledger(f); assert.equal(evidence.claims.length, 1); assert.equal(evidence.acks.length, 0);
  assert.equal(readFileSync(join(f.isolatedRoot, "legacy/one.md"), "utf8"), "# Decision\nKeep V1 authoritative.\n");
  assert.equal(existsSync(join(f.isolatedRoot, "legacy/two.md")), false);
  assert.deepEqual([tree(f.source.sourceRoot), tree(f.sealedPackage.rootPath), tree(f.liveVaultRoot)], protectedBefore);
});
test("rejects a transparent connection wrapper before the first compatibility claim", async t => {
  const { V2ShadowCompatibilityMaterializer } = await import(moduleUrl), f = await createCompatibilityFixture(t);
  let transactions = 0;
  const wrapper: SqliteConnection = { close: () => {}, prepare: sql => f.connection.prepare(sql), exec(sql) {
    if (sql.startsWith("BEGIN")) transactions++; f.connection.exec(sql);
  } };
  await assert.rejects(new V2ShadowCompatibilityMaterializer({ ...f.materializerOptions, connection: wrapper }).materializePending(f.input),
    (error: unknown) => error instanceof ShadowMigrationError && error.code === "COMPATIBILITY_INTEGRITY_FAILURE");
  assert.equal(transactions, 0); assert.deepEqual(readdirSync(f.isolatedRoot), []);
  assert.equal(f.repository.transact(f.projectionBinding.projectId, f.sealedPackage.migrationIdentity, tx => tx.readCompatibilityClaims()).length, 0);
});

test("refuses stale physical connection authority at entry and later claim or acknowledgement checks", async t => {
  for (const boundary of ["entry", "claim", "acknowledgement"] as const) await t.test(boundary, async child => {
    const { V2ShadowCompatibilityMaterializer } = await import(moduleUrl); let transactions = 0;
    class ObservedDatabase extends DatabaseSync {
      override exec(sql: string): void { if (sql.startsWith("BEGIN")) transactions++; super.exec(sql); }
    }
    const f = await createCompatibilityFixture(child, { database: ObservedDatabase });
    const replacement = join(f.root, "replacement.sqlite"), second = f.driver.open(replacement, { mode: "create", busyTimeoutMs: 5000 });
    const evidence = (connection: SqliteConnection) => ["v2_shadow_imported_records", "v2_shadow_compatibility_outbox", "v2_shadow_compatibility_claims", "v2_shadow_compatibility_acknowledgements"]
      .map(table => connection.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n);
    try { applyCurrentProjectStoreSchema(second, f.projectionBinding, f.manifest.createdAt);
      assert.deepEqual(second.prepare("SELECT project_id,vault_id,store_id FROM project_meta").get(), f.connection.prepare("SELECT project_id,vault_id,store_id FROM project_meta").get());
      assert.deepEqual(evidence(second), [0n, 0n, 0n, 0n]); }
    finally { second.close(); }
    const physical = (path: string) => { const stat = lstatSync(path, { bigint: true }); return { device: stat.dev, inode: stat.ino, links: stat.nlink }; };
    const protectedSnapshot = (path: string): unknown => {
      const stat = lstatSync(path); return { identity: physical(path), entries: stat.isDirectory()
        ? readdirSync(path).sort().map(name => ({ name, value: protectedSnapshot(join(path, name)) }))
        : createHash("sha256").update(readFileSync(path)).digest("hex") };
    };
    const protectedBefore = [protectedSnapshot(f.liveVaultRoot), protectedSnapshot(dirname(f.liveEventStorePath))];
    const identityA = physical(f.eventStorePath), identityB = physical(replacement), bytesB = readFileSync(replacement);
    let attempted = false, swapped = false, baseline = evidence(f.connection), attemptsBefore = 0;
    let retained = f.eventStorePath, bytesA = readFileSync(f.eventStorePath), isolatedBefore: unknown;
    const denied: string[] = [];
    const attempt = () => {
      attempted = true; baseline = evidence(f.connection); attemptsBefore = transactions;
      bytesA = readFileSync(f.eventStorePath); isolatedBefore = protectedSnapshot(f.isolatedRoot);
      const parent = dirname(f.eventStorePath);
      // Prefer moving the complete directory so an existing WAL stays with A on platforms permitting the move.
      try { renameSync(parent, `${parent}-retained`); mkdirSync(parent); retained = join(`${parent}-retained`, "events.sqlite"); swapped = true; }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (process.platform !== "win32" || !["EBUSY", "EPERM", "EACCES"].includes(code ?? "")) throw error;
        denied.push(`ancestor:${code}`);
        try { renameSync(f.eventStorePath, `${f.eventStorePath}.retained`); retained = `${f.eventStorePath}.retained`; swapped = true; }
        catch (ancestorError) {
          const ancestorCode = (ancestorError as NodeJS.ErrnoException).code;
          if (! ["EBUSY", "EPERM", "EACCES"].includes(ancestorCode ?? "")) throw ancestorError;
          denied.push(`file:${ancestorCode}`);
        }
      }
      if (swapped) {
        renameSync(replacement, f.eventStorePath);
        const named = f.connection.prepare("PRAGMA database_list").all().find(row => row.name === "main")!.file;
        assert.deepEqual(physical(String(named)), identityB); // The old pathname check would see B, not the held A.
      }
    };
    if (boundary === "entry") attempt();
    const materializer = new V2ShadowCompatibilityMaterializer({ ...f.materializerOptions, operationNow: () => {
      if (!attempted && (boundary === "claim" ? transactions === 2 : boundary === "acknowledgement" && existsSync(join(f.isolatedRoot, "legacy/one.md")))) {
        attempt(); if (!swapped) throw new Error("Windows prevented disposable replacement");
      }
      return 0;
    } });
    if (boundary !== "entry" || swapped) await assert.rejects(materializer.materializePending(f.input),
      (error: unknown) => error instanceof ShadowMigrationError && ["COMPATIBILITY_INTEGRITY_FAILURE", "MIGRATION_OUTCOME_UNKNOWN"].includes(error.code));
    assert.equal(attempted, true); assert.equal(transactions, attemptsBefore);
    assert.deepEqual(evidence(f.connection), baseline);
    assert.deepEqual(physical(retained), identityA); assert.deepEqual(readFileSync(retained), bytesA);
    assert.deepEqual(protectedSnapshot(f.isolatedRoot), isolatedBefore);
    assert.equal(baseline[3], 0n); assert.deepEqual([protectedSnapshot(f.liveVaultRoot), protectedSnapshot(dirname(f.liveEventStorePath))], protectedBefore);
    if (swapped) { assert.deepEqual(physical(f.eventStorePath), identityB); assert.deepEqual(readFileSync(f.eventStorePath), bytesB); }
    else {
      assert.equal(denied.length, 2); child.diagnostic(`Windows ${boundary} replacement prevented (${denied.join(",")}); not stale-handle refusal proof`);
      assert.deepEqual(physical(f.eventStorePath), identityA); assert.deepEqual(physical(replacement), identityB); assert.deepEqual(readFileSync(replacement), bytesB);
    }
    if (boundary !== "acknowledgement") assert.deepEqual(readdirSync(f.isolatedRoot), []);
  });
});
test("publishes exact committed artifact bytes below only the isolated root and proves a complete no-op", async t => {
  const { V2ShadowCompatibilityMaterializer } = await import(moduleUrl);
  const f = await createCompatibilityFixture(t), materializer = new V2ShadowCompatibilityMaterializer(f.materializerOptions);
  const liveIdentity = lstatSync(f.liveVaultRoot, { bigint: true }), before = readdirSync(f.liveVaultRoot);
  const result = await materializer.materializePending(f.input);
  assert.equal(result.acknowledgedCount, 2); assert.equal(result.highestAcknowledgedSourceOrdinal, 3);
  assert.equal(result.acknowledgedImportedPosition, 4n); assert.equal(result.materializationRevision, 4n);
  assert.equal(readFileSync(join(f.isolatedRoot, "legacy/one.md"), "utf8"), "# Decision\nKeep V1 authoritative.\n");
  assert.equal(readFileSync(join(f.isolatedRoot, "legacy/two.md"), "utf8"), "# Insight\nตรวจสอบ immutable copy.\n");
  const inode = lstatSync(join(f.isolatedRoot, "legacy/one.md"), { bigint: true }).ino;
  const replay = await materializer.materializePending(f.input);
  assert.deepEqual(replay, { ...result, deduplicated: true });
  assert.equal(lstatSync(join(f.isolatedRoot, "legacy/one.md"), { bigint: true }).ino, inode);
  assert.deepEqual(f.repository.transact(f.projectionBinding.projectId, f.sealedPackage.migrationIdentity, tx => tx.readPendingCompatibility()), []);
  assert.deepEqual(readdirSync(f.liveVaultRoot), before); assert.equal(lstatSync(f.liveVaultRoot, { bigint: true }).ino, liveIdentity.ino);
});

test("rejects the live vault and refuses a lagged completed target without restoring deleted bytes", async t => {
  const { V2ShadowCompatibilityMaterializer } = await import(moduleUrl);
  const f = await createCompatibilityFixture(t);
  await assert.rejects(new V2ShadowCompatibilityMaterializer({ ...f.materializerOptions, isolatedRoot: f.liveVaultRoot }).materializePending(f.input),
    (error: unknown) => error instanceof ShadowMigrationError && error.code === "COMPATIBILITY_INTEGRITY_FAILURE");
  const materializer = new V2ShadowCompatibilityMaterializer(f.materializerOptions);
  await materializer.materializePending(f.input); unlinkSync(join(f.isolatedRoot, "legacy/one.md"));
  await assert.rejects(materializer.materializePending(f.input));
  assert.deepEqual(readdirSync(join(f.isolatedRoot, "legacy")), ["two.md"]);
});

test("authenticates zero-artifact imports and returns null maxima and an empty-set checksum", async t => {
  const { V2ShadowCompatibilityMaterializer } = await import(moduleUrl);
  const f = await createCompatibilityFixture(t, { legacyArtifacts: false });
  const materializer = new V2ShadowCompatibilityMaterializer(f.materializerOptions);
  const result = await materializer.materializePending(f.input);
  assert.equal(result.acknowledgedCount, 0); assert.equal(result.aggregateBytes, 0);
  assert.equal(result.highestAcknowledgedSourceOrdinal, null); assert.equal(result.acknowledgedImportedPosition, null);
  assert.equal(result.materializationRevision, null); assert.equal(result.artifactSetChecksum, "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945");
  assert.deepEqual(await materializer.materializePending(f.input), result);
});

test("reconciles replacement before acknowledgement failure without rewriting installed bytes or exposing plaintext", async t => {
  const { V2ShadowCompatibilityMaterializer } = await import(moduleUrl);
  let interrupt = true;
  class AcknowledgementFaultDatabase extends DatabaseSync {
    override prepare(sql: string): StatementSync {
      if (interrupt && sql.startsWith("INSERT INTO v2_shadow_compatibility_acknowledgements")) throw new Error("sensitive bytes and absolute target must not escape");
      return super.prepare(sql);
    }
  }
  const f = await createCompatibilityFixture(t, { database: AcknowledgementFaultDatabase });
  const materializer = new V2ShadowCompatibilityMaterializer(f.materializerOptions);
  await assert.rejects(materializer.materializePending(f.input), (error: unknown) => {
    assert.ok(error instanceof ShadowMigrationError); assert.equal(error.code, "MIGRATION_OUTCOME_UNKNOWN");
    assert.doesNotMatch(JSON.stringify(error) + error.message, /sensitive|absolute target|Keep V1|ตรวจสอบ/); return true;
  });
  const target = join(f.isolatedRoot, "legacy/one.md"), inode = lstatSync(target, { bigint: true }).ino;
  assert.equal(f.repository.transact(f.projectionBinding.projectId, f.sealedPackage.migrationIdentity, tx => tx.readCompatibilityAcknowledgements()).length, 0);
  interrupt = false; const recovered = await materializer.materializePending(f.input);
  assert.equal(recovered.acknowledgedCount, 2); assert.equal(lstatSync(target, { bigint: true }).ino, inode);
});

test("rejects wrong deterministic claims and missing targets for prior claims without mutation", async t => {
  for (const variant of ["owner", "claim-id", "time", "missing-target"] as const) await t.test(variant, async child => {
    const { V2ShadowCompatibilityMaterializer } = await import(moduleUrl); const f = await createCompatibilityFixture(child);
    const ordinal = 2, migration = f.sealedPackage.migrationIdentity, id = deterministicMigrationUuid("claim", migration, ordinal);
    f.repository.transact(f.projectionBinding.projectId, migration, tx => tx.claimCompatibility({ projectId: f.projectionBinding.projectId,
      migrationIdentity: migration, outboxId: id, claimId: variant === "claim-id" ? deterministicMigrationUuid("claim", migration, 30) : id,
      claimOwnerFingerprint: variant === "owner" ? "f".repeat(64) : createHash("sha256").update(`project-memory/v2-shadow-compatibility-owner/v1\n${migration}`).digest("hex"),
      claimedAt: variant === "time" ? "2026-09-10T00:00:01.000Z" : "2026-09-10T00:00:00.002Z" }));
    await assert.rejects(new V2ShadowCompatibilityMaterializer(f.materializerOptions).materializePending(f.input));
    assert.deepEqual(readdirSync(f.isolatedRoot), []);
    assert.equal(f.repository.transact(f.projectionBinding.projectId, migration, tx => tx.readCompatibilityAcknowledgements()).length, 0);
  });
});

test("refuses the wrong connected store and a noncanonical acknowledgement clock before claims", async t => {
  const { V2ShadowCompatibilityMaterializer } = await import(moduleUrl); const f = await createCompatibilityFixture(t);
  const other = await createCompatibilityFixture(t);
  for (const options of [{ ...f.materializerOptions, connection: other.connection },
    { ...f.materializerOptions, acknowledgementNow: () => "2026-09-10T00:00:01.000Z" }]) {
    await assert.rejects(new V2ShadowCompatibilityMaterializer(options).materializePending(f.input));
    assert.deepEqual(readdirSync(f.isolatedRoot), []);
    assert.equal(f.repository.transact(f.projectionBinding.projectId, f.sealedPackage.migrationIdentity, tx => tx.readCompatibilityClaims()).length, 0);
  }
});

test("rejects missing and extra complete outbox evidence before publishing any target", async t => {
  for (const variant of ["missing", "extra-source-kind"] as const) await t.test(variant, async child => {
    const { V2ShadowCompatibilityMaterializer } = await import(moduleUrl); const f = await createCompatibilityFixture(child);
    if (variant === "missing") {
      // Simulate a corrupted isolated ledger, preserving authenticated events and import receipts.
      const triggers = f.connection.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='v2_shadow_compatibility_outbox'").all();
      for (const trigger of triggers) f.connection.exec(`DROP TRIGGER "${String(trigger.name).replace(/"/g, '""')}"`);
      f.connection.exec("DELETE FROM v2_shadow_compatibility_outbox WHERE source_ordinal=2");
    } else f.repository.transact(f.projectionBinding.projectId, f.sealedPackage.migrationIdentity, tx => {
      const receipt = tx.readImportedRecords()[0]!, artifact = tx.readCompatibilityOutbox()[0]!;
      tx.enqueueCompatibility([{ ...artifact, outboxId: deterministicMigrationUuid("claim", f.sealedPackage.migrationIdentity, 0),
        sourceOrdinal: 0, importedEventId: receipt.importedEventId, importedGlobalPosition: receipt.importedGlobalPosition,
        importedEventHash: receipt.importedEventHash, relativePath: "extra.md", materializationRevision: 1n }]);
    });
    await assert.rejects(new V2ShadowCompatibilityMaterializer(f.materializerOptions).materializePending(f.input));
    assert.deepEqual(readdirSync(f.isolatedRoot), []);
    assert.equal(f.repository.transact(f.projectionBinding.projectId, f.sealedPackage.migrationIdentity, tx => tx.readCompatibilityClaims()).length, 0);
  });
});
