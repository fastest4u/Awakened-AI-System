import assert from "node:assert/strict";
import { appendFileSync, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { inspect } from "node:util";
import { decodeV1SourceCopyManifestV1, verifyV1SourceCopy } from "../src/orchestrator/migration/v1-source-copy.js";
import { ShadowMigrationError } from "../src/orchestrator/migration/v2-shadow-migration.contracts.js";
import type { SqliteDriver } from "../src/orchestrator/storage/sqlite-driver.js";
import { createV2ShadowMigrationFixture, describeSourceFile, sealManifest } from "./support/v2-shadow-migration-fixture.js";

function redacted(code: ShadowMigrationError["code"] = "MIGRATION_SOURCE_INVALID") {
  return (error: unknown) => {
    assert.ok(error instanceof ShadowMigrationError);
    assert.equal(error.code, code);
    assert.ok(Object.keys(error.safeDetails).every((key) => key === "category" || key === "ordinal"));
    assert.doesNotMatch(inspect(error), /one\.md|events\.sqlite|v2-shadow-source-|SECRET/);
    return true;
  };
}

test("verifies the complete read-only source and detects later mutation", async (t) => {
  const f = await createV2ShadowMigrationFixture(t);
  const paths = [f.manifestPath, f.sourceDatabasePath, ...f.manifest.sqliteSidecars.map((d) => join(f.sourceRoot, d.relativePath)),
    ...f.manifest.legacyArtifacts.map((d) => join(f.sourceRoot, d.relativePath)), f.liveEventStorePath];
  const before = paths.map((path) => readFileSync(path));
  const verified = await verifyV1SourceCopy(f.verificationInput);
  assert.equal(verified.manifest.eventCount, f.sourceEvents.length);
  assert.equal(verified.manifest.terminalEventHash, f.sourceEvents.at(-1)!.eventHash);
  assert.equal([...verified.events()].length, f.sourceEvents.length);
  verified.assertUnchanged();
  paths.forEach((path, i) => assert.deepEqual(readFileSync(path), before[i]));
  appendFileSync(f.sourceDatabasePath, Buffer.from([0]));
  assert.throws(() => verified.assertUnchanged(), redacted("MIGRATION_SOURCE_MUTATED"));
  verified.close();
  verified.close();
});

test("returns deeply frozen public data and defensive artifact chunks", async (t) => {
  const f = await createV2ShadowMigrationFixture(t);
  const verified = await verifyV1SourceCopy(f.verificationInput);
  for (const object of [verified, verified.manifest, verified.manifest.database, verified.manifest.sqliteSidecars,
    verified.manifest.legacyArtifacts, verified.projectionSnapshot, verified.projectionSnapshot.binding, ...verified.events()]) {
    assert.ok(Object.isFrozen(object));
  }
  const artifact = [...verified.legacyArtifacts()][0]!;
  assert.ok(Object.isFrozen(artifact));
  assert.ok(Object.isFrozen(artifact.descriptor));
  const expected = Buffer.concat([...artifact.readChunks()]);
  const chunks = [...artifact.readChunks()]; chunks[0]!.fill(0);
  assert.deepEqual(Buffer.concat([...artifact.readChunks()]), expected);
  const input = structuredClone(f.manifest);
  const decoded = decodeV1SourceCopyManifestV1(input);
  (input.database as { sha256: string }).sha256 = "0".repeat(64);
  assert.notEqual(decoded.database.sha256, input.database.sha256);
  verified.close();
  assert.throws(() => verified.events(), redacted());
});

test("rejects a source whose file identity aliases live authority", async (t) => {
  const f = await createV2ShadowMigrationFixture(t, { aliasLiveStore: true });
  await assert.rejects(verifyV1SourceCopy(f.verificationInput), redacted());
});

test("rejects an artifact hardlinked to live-vault authority before SQLite opens with redacted errors", async (t) => {
  const f = await createV2ShadowMigrationFixture(t);
  const artifactPath = join(f.sourceRoot, "legacy/one.md");
  const livePath = join(f.liveVaultRoot, "SECRET-live-artifact.md");
  copyFileSync(artifactPath, livePath);
  rmSync(artifactPath);
  linkSync(livePath, artifactPath);
  assert.equal(lstatSync(artifactPath, { bigint: true }).nlink, 2n);
  f.writeManifest({ ...f.manifest, legacyArtifacts: f.manifest.legacyArtifacts.map((d) => ({
    ...d, ...describeSourceFile(f.sourceRoot, d.relativePath),
  })) });
  let opens = 0;
  const driver: SqliteDriver = { open(path, options) { opens++; return f.driver.open(path, options); } };
  await assert.rejects(verifyV1SourceCopy({ ...f.verificationInput, driver }), redacted());
  assert.equal(opens, 0);
});

for (const relativePath of ["events.sqlite", "events.sqlite-wal", "events.sqlite-shm", "legacy/one.md", "manifest.json"]) {
  test(`rejects a unique declared ${relativePath} with an undeclared external hardlink before SQLite opens`, async (t) => {
    const f = await createV2ShadowMigrationFixture(t);
    const path = join(f.sourceRoot, relativePath);
    linkSync(path, join(f.root, "SECRET-external-alias"));
    assert.equal(lstatSync(path, { bigint: true }).nlink, 2n);
    // Reseal after link creation so descriptor ctime checks cannot mask missing link-count validation.
    f.writeManifest({ ...f.manifest, database: describeSourceFile(f.sourceRoot, f.manifest.database.relativePath),
      sqliteSidecars: f.manifest.sqliteSidecars.map((d) => describeSourceFile(f.sourceRoot, d.relativePath)),
      legacyArtifacts: f.manifest.legacyArtifacts.map((d) => ({ ...d, ...describeSourceFile(f.sourceRoot, d.relativePath) })),
    });
    let opens = 0;
    const driver: SqliteDriver = { open(path, options) { opens++; return f.driver.open(path, options); } };
    await assert.rejects(verifyV1SourceCopy({ ...f.verificationInput, driver }), redacted());
    assert.equal(opens, 0);
  });

  test(`detects a new external hardlink to ${relativePath} after verification`, async (t) => {
    const f = await createV2ShadowMigrationFixture(t);
    const verified = await verifyV1SourceCopy(f.verificationInput);
    try {
      const path = join(f.sourceRoot, relativePath);
      linkSync(path, join(f.root, "SECRET-later-alias"));
      assert.equal(lstatSync(path, { bigint: true }).nlink, 2n);
      assert.throws(() => verified.assertUnchanged(), redacted("MIGRATION_SOURCE_MUTATED"));
    } finally { verified.close(); }
  });
}

for (const root of ["store", "vault", "ancestor", "descendant"] as const) test(`rejects ${root} root containment before SQLite open`, async (t) => {
  const f = await createV2ShadowMigrationFixture(t);
  const sourceRoot = root === "store" ? join(f.root, "live-store") : root === "vault" ? f.liveVaultRoot : root === "ancestor" ? f.root : join(f.liveVaultRoot, "child");
  if (root === "descendant") mkdirSync(sourceRoot);
  let opened = false;
  const driver: SqliteDriver = { open() { opened = true; throw new Error("SECRET"); } };
  await assert.rejects(verifyV1SourceCopy({ ...f.verificationInput, sourceRoot, driver }), redacted());
  assert.equal(opened, false);
});

for (const path of ["../outside.md", "/outside.md", "C:\\outside.md", "legacy\\..\\outside.md", "legacy/./one.md", "legacy/one.md\0", "legacy/one.md:stream"]) {
  test(`rejects hostile relative path ${JSON.stringify(path)}`, async (t) => {
    const f = await createV2ShadowMigrationFixture(t);
    f.writeManifest({ ...f.manifest, legacyArtifacts: [{ ...f.manifest.legacyArtifacts[0]!, relativePath: path }] });
    await assert.rejects(verifyV1SourceCopy(f.verificationInput), redacted());
  });
}

test("rejects file symlinks without weakening Windows production checks", async (t) => {
  const f = await createV2ShadowMigrationFixture(t);
  const path = join(f.sourceRoot, "legacy/one.md"); rmSync(path);
  try { symlinkSync(join(f.sourceRoot, "legacy/two.md"), path, "file"); }
  catch (error) {
    if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") { t.skip("Windows account lacks file-symlink privilege; junction rejection runs separately"); return; }
    throw error;
  }
  await assert.rejects(verifyV1SourceCopy(f.verificationInput), redacted());
});

test("rejects junction or directory symlink components", async (t) => {
  const f = await createV2ShadowMigrationFixture(t);
  const path = join(f.sourceRoot, "legacy"); renameSync(path, join(f.sourceRoot, "original"));
  symlinkSync(join(f.sourceRoot, "original"), path, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(verifyV1SourceCopy(f.verificationInput), redacted());
});

for (const kind of ["duplicate identity", "case collision", "directory", "sidecar hash", "undeclared sidecar", "descriptor mismatch", "manifest checksum", "wrong binding", "unsupported schema", "count", "bytes", "terminal hash", "terminal position"] as const) {
  test(`rejects ${kind}`, async (t) => {
    const f = await createV2ShadowMigrationFixture(t);
    let manifest = structuredClone(f.manifest);
    if (kind === "duplicate identity") {
      const path = join(f.sourceRoot, "legacy/two.md"); rmSync(path); linkSync(join(f.sourceRoot, "legacy/one.md"), path);
      manifest = { ...manifest, legacyArtifacts: manifest.legacyArtifacts.map((d) => ({ ...d, ...describeSourceFile(f.sourceRoot, d.relativePath) })) };
    } else if (kind === "case collision") manifest = { ...manifest, legacyArtifacts: [...manifest.legacyArtifacts, { ...manifest.legacyArtifacts[0]!, relativePath: "LEGACY/ONE.md" }] };
    else if (kind === "directory") { rmSync(join(f.sourceRoot, "legacy/one.md")); mkdirSync(join(f.sourceRoot, "legacy/one.md")); }
    else if (kind === "sidecar hash") manifest = { ...manifest, sqliteSidecars: manifest.sqliteSidecars.map((d) => ({ ...d, sha256: "0".repeat(64) })) };
    else if (kind === "undeclared sidecar") manifest = { ...manifest, sqliteSidecars: [] };
    else if (kind === "descriptor mismatch") manifest = { ...manifest, database: { ...manifest.database, inode: "0" } };
    else if (kind === "wrong binding") manifest = { ...manifest, storeId: "44444444-4444-4444-8444-444444444444" };
    else if (kind === "unsupported schema") manifest = { ...manifest, sourceSchemaVersion: 999 };
    else if (kind === "count") manifest = { ...manifest, eventCount: 1 };
    else if (kind === "bytes") manifest = { ...manifest, aggregateSourceBytes: manifest.aggregateSourceBytes + 1 };
    else if (kind === "terminal hash") manifest = { ...manifest, terminalEventHash: "0".repeat(64) };
    else if (kind === "terminal position") manifest = { ...manifest, terminalEventPosition: "3" };
    f.writeManifest(manifest);
    if (kind === "manifest checksum") writeFileSync(f.manifestPath, JSON.stringify({ ...manifest, manifestChecksum: "0".repeat(64) }));
    await assert.rejects(verifyV1SourceCopy(f.verificationInput), redacted());
  });
}

test("rejects authenticated chain tampering even with resealed file and manifest hashes", async (t) => {
  const f = await createV2ShadowMigrationFixture(t);
  const db = new DatabaseSync(f.sourceDatabasePath);
  try {
    for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'events'").all()) db.exec(`DROP TRIGGER "${String(row.name).replaceAll('"', '""')}"`);
    db.exec("UPDATE events SET agent_id = 'SECRET' WHERE global_position = 1; PRAGMA wal_checkpoint(TRUNCATE)");
  } finally { db.close(); }
  // Re-open a copy writer to supply stable, checkpointed WAL and SHM sidecars.
  const writer = f.driver.open(f.sourceDatabasePath, { mode: "existing", busyTimeoutMs: 5000 });
  try {
    writer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    f.writeManifest({ ...f.manifest, database: describeSourceFile(f.sourceRoot, "events.sqlite"),
      sqliteSidecars: ["events.sqlite-wal", "events.sqlite-shm"].map((p) => describeSourceFile(f.sourceRoot, p)) });
    await assert.rejects(verifyV1SourceCopy(f.verificationInput), redacted());
  } finally { writer.close(); }
});

for (const kind of ["events", "aggregate", "artifact", "event"] as const) test(`enforces ${kind} source limit`, async (t) => {
  const f = await createV2ShadowMigrationFixture(t);
  let opened = 0;
  const driver: SqliteDriver = { open(path, options) { opened++; return f.driver.open(path, options); } };
  const policy = { ...f.policy, ...(kind === "events" ? { maxEvents: 1 } : kind === "aggregate" ? { maxAggregateBytes: 1 }
    : { maxEventBytes: kind === "artifact" ? 1 : 128 }) };
  await assert.rejects(verifyV1SourceCopy({ ...f.verificationInput, driver, policy }), redacted("MIGRATION_LIMIT_EXCEEDED"));
  if (kind !== "event") assert.equal(opened, 0);
});

test("database bytes do not consume logical aggregate policy ceiling", async (t) => {
  const f = await createV2ShadowMigrationFixture(t);
  assert.ok(f.manifest.database.size > f.manifest.aggregateSourceBytes);
  const verified = await verifyV1SourceCopy({ ...f.verificationInput, policy: { ...f.policy, maxAggregateBytes: f.manifest.aggregateSourceBytes } });
  verified.close();
});

test("replays only a verified private working image and removes it without changing source descriptors", async (t) => {
  const f = await createV2ShadowMigrationFixture(t);
  const descriptors = [f.manifest.database, ...f.manifest.sqliteSidecars, ...f.manifest.legacyArtifacts];
  let scratchPath = "";
  let closes = 0;
  const driver: SqliteDriver = { open(path, options) {
    scratchPath = path;
    assert.equal(options.mode, "read-only-existing");
    assert.ok(!path.startsWith(f.sourceRoot));
    assert.deepEqual(readFileSync(path), readFileSync(f.sourceDatabasePath));
    const connection = f.driver.open(path, options);
    return { exec: (sql) => connection.exec(sql), prepare: (sql) => connection.prepare(sql),
      close() { closes++; connection.close(); } };
  } };
  const verified = await verifyV1SourceCopy({ ...f.verificationInput, driver });
  assert.equal(closes, 1);
  assert.equal(existsSync(scratchPath), false);
  for (const expected of descriptors) assert.deepEqual(describeSourceFile(f.sourceRoot, expected.relativePath),
    Object.fromEntries(Object.entries(expected).filter(([key]) => key !== "mediaType")));
  verified.close(); verified.projectionSnapshot.close(); verified.close();
  assert.equal(closes, 1);
});

for (const kind of ["database", "artifact", "manifest", "directory"] as const) test(`post-read revalidation detects ${kind} mutation and closes exactly once`, async (t) => {
  const f = await createV2ShadowMigrationFixture(t);
  let closes = 0;
  const driver: SqliteDriver = { open(path, options) {
    assert.equal(options.mode, "read-only-existing");
    const connection = f.driver.open(path, options);
    return { exec: (sql) => connection.exec(sql), prepare: (sql) => connection.prepare(sql), close() {
      closes++; connection.close();
      if (kind === "database") appendFileSync(f.sourceDatabasePath, Buffer.from([0]));
      if (kind === "artifact") appendFileSync(join(f.sourceRoot, "legacy/one.md"), "SECRET");
      if (kind === "manifest") appendFileSync(f.manifestPath, " ");
      if (kind === "directory") { renameSync(join(f.sourceRoot, "legacy"), join(f.sourceRoot, "moved")); mkdirSync(join(f.sourceRoot, "legacy")); copyFileSync(join(f.sourceRoot, "moved/one.md"), join(f.sourceRoot, "legacy/one.md")); }
    } };
  } };
  await assert.rejects(verifyV1SourceCopy({ ...f.verificationInput, driver }), redacted("MIGRATION_SOURCE_MUTATED"));
  assert.equal(closes, 1);
});

test("closes a failed replay exactly once and redacts driver failures", async (t) => {
  const f = await createV2ShadowMigrationFixture(t);
  let closes = 0;
  let scratchPath = "";
  const driver: SqliteDriver = { open(path, options) {
    scratchPath = path;
    const connection = f.driver.open(path, options);
    return { exec: (sql) => connection.exec(sql), prepare(sql) { if (sql.includes("FROM events")) throw new Error("SECRET events.sqlite"); return connection.prepare(sql); },
      close() { closes++; connection.close(); } };
  } };
  await assert.rejects(verifyV1SourceCopy({ ...f.verificationInput, driver }), redacted());
  assert.equal(closes, 1);
  assert.equal(existsSync(scratchPath), false);
});

test("rejects a manifest that omits the committed database tail", async (t) => {
  const f = await createV2ShadowMigrationFixture(t);
  f.writeManifest({ ...f.manifest, eventCount: 1, terminalEventPosition: "1", terminalEventHash: f.sourceEvents[0]!.eventHash,
    aggregateSourceBytes: f.manifest.aggregateSourceBytes - Buffer.byteLength(f.sourceEvents[1]!.payloadJson) });
  await assert.rejects(verifyV1SourceCopy(f.verificationInput), redacted());
});

test("verifies a checkpointed database without sidecars without creating source files", async (t) => {
  const f = await createV2ShadowMigrationFixture(t);
  for (const suffix of ["-wal", "-shm"]) rmSync(`${f.sourceDatabasePath}${suffix}`);
  f.writeManifest({ ...f.manifest, sqliteSidecars: [] });
  const verified = await verifyV1SourceCopy(f.verificationInput);
  verified.close();
  for (const suffix of ["-wal", "-shm"]) assert.equal(existsSync(`${f.sourceDatabasePath}${suffix}`), false);
});

test("rejects scratch configuration inside the source before creating any directory", async (t) => {
  const f = await createV2ShadowMigrationFixture(t);
  const before = lstatSync(f.sourceRoot, { bigint: true }).ctimeNs;
  const key = process.platform === "win32" ? "TEMP" : "TMPDIR";
  const original = process.env[key];
  process.env[key] = f.sourceRoot;
  try { await assert.rejects(verifyV1SourceCopy(f.verificationInput), redacted()); }
  finally { if (original === undefined) delete process.env[key]; else process.env[key] = original; }
  assert.equal(lstatSync(f.sourceRoot, { bigint: true }).ctimeNs, before);
});

test("strict decoder rejects accessors, proxies, inherited/extra/symbol fields and hostile arrays without traps", async (t) => {
  const f = await createV2ShadowMigrationFixture(t);
  let traps = 0;
  const handler = { get() { traps++; throw Error("SECRET"); }, ownKeys() { traps++; throw Error("SECRET"); }, getPrototypeOf() { traps++; throw Error("SECRET"); } };
  const accessor = { ...f.manifest }; Object.defineProperty(accessor, "database", { enumerable: true, get() { traps++; throw Error("SECRET"); } });
  const nested = { ...f.manifest, database: new Proxy(f.manifest.database, handler) };
  const array = { ...f.manifest, legacyArtifacts: new Proxy([...f.manifest.legacyArtifacts], handler) };
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  for (const input of [accessor, nested, array, new Proxy(f.manifest, handler), revoked.proxy, Object.create(f.manifest),
    { ...f.manifest, extra: true }, { ...f.manifest, [Symbol("extra")]: true }, { ...f.manifest, sqliteSidecars: Array(2) },
    { ...f.manifest, database: { ...f.manifest.database, size: -0 } }, { ...f.manifest, terminalEventPosition: "01" },
    { ...f.manifest, createdAt: "not-a-date" }]) assert.throws(() => decodeV1SourceCopyManifestV1(input), redacted());
  assert.equal(traps, 0);
  assert.deepEqual(decodeV1SourceCopyManifestV1(sealManifest(f.manifest)), f.manifest);
});
