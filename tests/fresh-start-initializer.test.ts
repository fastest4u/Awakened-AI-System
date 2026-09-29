import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { NodeSqliteDriver } from "../src/orchestrator/storage/node-sqlite-driver.js";
import { applyCurrentProjectStoreSchema } from "./support/current-project-store-schema.js";
import { join } from "node:path";
import { test } from "node:test";
import { freshInitializationFixture } from "./support/fresh-start-fixture.js";

// Dynamic loading keeps the first RED build executable before the feature exists.
const modulePath = "../src/orchestrator/fresh-start/fresh-start-initializer.js";
const pathsPath = "../src/orchestrator/fresh-start/fresh-start-paths.js";
async function implementation() {
  try { return await import(modulePath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND") assert.fail("FreshStartInitializer implementation is missing");
    throw error;
  }
}

test("fresh initialization installs a prepared receipt with actual empty projection checksums and preserves V1", async () => {
  const f = freshInitializationFixture();
  try {
    const before = statSync(f.sentinel); const archive = statSync(f.input.v1ArchiveRoot);
    const { FreshStartInitializer } = await implementation();
    const initializer = new FreshStartInitializer(f.dependencies);
    const receipt = await initializer.initializeFresh(f.input);
    assert.equal(receipt.semanticPosition, "0");
    assert.equal(Object.keys(receipt.projectionChecksums).length, 8);
    assert.ok(Object.values(receipt.projectionChecksums).every(value => value !== "0".repeat(64)));
    assert.deepEqual(await initializer.openExisting(f.input), receipt);
    const journal = JSON.parse(readFileSync(f.journalPath, "utf8"));
    assert.equal(journal.phase, "receipt-published");
    assert.equal(journal.identity.storeId, receipt.storeId);
    assert.equal(statSync(f.sentinel).mtimeMs, before.mtimeMs);
    assert.equal(statSync(f.sentinel).size, before.size);
    assert.equal(statSync(f.input.v1ArchiveRoot).mtimeMs, archive.mtimeMs);
    assert.equal(readFileSync(f.sentinel, "utf8"), "synthetic archive must remain untouched");
    await assert.rejects(initializer.initializeFresh(f.input), { code: "FRESH_START_ALREADY_INITIALIZED" });
  } finally { f.cleanup(); }
});

test("archive equal, ancestor, descendant and junction/case aliases refuse before descriptor creation", async () => {
  const f = freshInitializationFixture();
  try {
    const { FreshStartInitializer } = await implementation();
    const { assertFreshStartPaths } = await import(pathsPath);
    for (const v2VaultRoot of [f.input.v1ArchiveRoot, f.input.projectRoot, join(f.input.v1ArchiveRoot, "nested")]) {
      await assert.rejects(new FreshStartInitializer(f.dependencies).initializeFresh({ ...f.input, v2VaultRoot }), { code: "FRESH_START_PATH_OVERLAP" });
    }
    const alias = join(f.input.projectRoot, "archive-alias");
    symlinkSync(f.input.v1ArchiveRoot, alias, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(assertFreshStartPaths({ ...f.input, v2VaultRoot: alias }), { code: "FRESH_START_PATH_OVERLAP" });
    if (process.platform === "win32") await assert.rejects(assertFreshStartPaths({ ...f.input, v2VaultRoot: f.input.v1ArchiveRoot.toUpperCase() }), { code: "FRESH_START_PATH_OVERLAP" });
    assert.equal(existsSync(join(f.input.v1ArchiveRoot, ".memory-mcp")), false);
  } finally { f.cleanup(); }
});

test("nonempty destination and untrusted or mismatched build refuse without descriptor", async () => {
  const f = freshInitializationFixture();
  try {
    const { FreshStartInitializer } = await implementation();
    await assert.rejects(new FreshStartInitializer().initializeFresh(f.input), { code: "FRESH_START_PREPARATION_REQUIRED" });
    await assert.rejects(new FreshStartInitializer(f.dependencies).initializeFresh({ ...f.input, release: { ...f.input.release, buildIdentityHash: "0".repeat(64) } }), { code: "FRESH_START_RELEASE_MISMATCH" });
    writeFileSync(join(f.input.v2VaultRoot, "foreign.txt"), "keep");
    await assert.rejects(new FreshStartInitializer(f.dependencies).initializeFresh(f.input), { code: "FRESH_START_DESTINATION_NOT_EMPTY" });
    assert.equal(existsSync(join(f.input.v2VaultRoot, ".memory-mcp", "project-identity.json")), false);
  } finally { f.cleanup(); }
});

for (const boundary of ["after-journal-reserved", "after-descriptor-published", "after-temp-schema-before-identity", "after-temp-complete-before-publish", "after-database-publish-before-manifest", "after-store-published", "after-projection-verified", "after-receipt-installed", "after-receipt-published"]) {
  test(`new instance resumes stable identities after ${boundary}`, async () => {
    const f = freshInitializationFixture();
    try {
      const { FreshStartInitializer } = await implementation();
      await assert.rejects(new FreshStartInitializer({ ...f.dependencies, faultInjector: { hit: (at: string) => { if (at === boundary) throw new Error("owned interruption"); } } }).initializeFresh(f.input), /owned interruption/);
      const journal = JSON.parse(readFileSync(f.journalPath, "utf8"));
      await assert.rejects(new FreshStartInitializer(f.dependencies).resumeInitialization({ ...f.input, initializationId: randomUUID() }), { code: "FRESH_START_JOURNAL_MISMATCH" });
      if (boundary !== "after-receipt-published") await assert.rejects(new FreshStartInitializer().openExisting(f.input), { code: "FRESH_START_RECOVERY_REQUIRED" });
      const receipt = await new FreshStartInitializer(f.dependencies).resumeInitialization(f.input);
      assert.equal(receipt.projectId, journal.identity.projectId);
      assert.equal(receipt.vaultId, journal.identity.vaultId);
      assert.equal(receipt.storeId, journal.identity.storeId);
      assert.deepEqual(await new FreshStartInitializer().openExisting(f.input), receipt);
    } finally { f.cleanup(); }
  });
}

test("missing acknowledged database never recreates fresh storage on open or resume", async () => {
  const f = freshInitializationFixture();
  try {
    const { FreshStartInitializer } = await implementation();
    await new FreshStartInitializer(f.dependencies).initializeFresh(f.input);
    unlinkSync(f.databasePath);
    await assert.rejects(new FreshStartInitializer().openExisting(f.input), { code: "FRESH_START_RECOVERY_REQUIRED" });
    await assert.rejects(new FreshStartInitializer(f.dependencies).resumeInitialization(f.input), { code: "FRESH_START_RECOVERY_REQUIRED" });
    assert.equal(existsSync(f.databasePath), false);
  } finally { f.cleanup(); }
});

test("exclusive journal admits exactly one concurrent initializer", async () => {
  const f = freshInitializationFixture();
  try {
    const { FreshStartInitializer } = await implementation();
    const results = await Promise.allSettled([1, 2].map(() => new FreshStartInitializer(f.dependencies).initializeFresh(f.input)));
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(results.filter(result => result.status === "rejected").length, 1);
    await new FreshStartInitializer().openExisting(f.input);
  } finally { f.cleanup(); }
});

test("real concurrent processes cannot both initialize the same destination", async () => {
  const f = freshInitializationFixture();
  try {
    const source = `import { FreshStartInitializer } from ${JSON.stringify(new URL(modulePath, import.meta.url).href)};
      import { createHash } from 'node:crypto'; import { readFileSync } from 'node:fs';
      const input = JSON.parse(process.argv[1]);
      const initializer = new FreshStartInitializer({ inspectBuild: () => createHash('sha256').update(readFileSync(process.argv[2])).digest('hex'), actorFingerprint: process.argv[3] });
      try { console.log(JSON.stringify(await initializer.initializeFresh(input))); }
      catch (error) { console.log(JSON.stringify({ code: error.code })); process.exitCode = 2; }`;
    const run = () => new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", source, JSON.stringify(f.input), f.artifact, f.dependencies.actorFingerprint], { windowsHide: true });
      let output = ""; child.stdout.on("data", data => { output += String(data); });
      child.on("error", reject); child.on("close", code => resolve({ code, output }));
    });
    const results = await Promise.all([run(), run()]);
    assert.deepEqual(results.map(result => result.code).sort(), [0, 2]);
    const winner = JSON.parse(results.find(result => result.code === 0)!.output);
    const { FreshStartInitializer } = await implementation();
    assert.deepEqual(await new FreshStartInitializer().openExisting(f.input), winner);
  } finally { f.cleanup(); }
});

test("Git-routed store cannot write under an archive containing gitCommonDir", async () => {
  const f = freshInitializationFixture();
  try {
    for (const args of [["init"], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "owned fixture"]]) {
      assert.equal(spawnSync("git", args, { cwd: f.input.projectRoot, windowsHide: true }).status, 0);
    }
    const archive = join(f.input.projectRoot, ".git");
    const before = statSync(archive).mtimeMs;
    const { FreshStartInitializer } = await implementation();
    await assert.rejects(new FreshStartInitializer(f.dependencies).initializeFresh({ ...f.input, v1ArchiveRoot: archive }), { code: "FRESH_START_PATH_OVERLAP" });
    assert.equal(existsSync(join(archive, "project-memory")), false);
    assert.equal(existsSync(join(f.input.v2VaultRoot, ".memory-mcp")), false);
    assert.equal(statSync(archive).mtimeMs, before);
  } finally { f.cleanup(); }
});

test("archive junction substitution after descriptor publication refuses before bootstrap probe writes", async () => {
  const f = freshInitializationFixture();
  try {
    const { FreshStartInitializer } = await implementation();
    await assert.rejects(new FreshStartInitializer({ ...f.dependencies, faultInjector: { hit: (at: string) => {
      if (at === "after-descriptor-published") {
        symlinkSync(f.input.v1ArchiveRoot, join(f.input.v2VaultRoot, ".memory-mcp", "v2"), process.platform === "win32" ? "junction" : "dir");
      }
    } } }).initializeFresh(f.input), error => ["FRESH_START_PATH_OVERLAP", "FRESH_START_PATH_CHANGED"].includes((error as { code: string }).code));
    assert.equal(existsSync(join(f.input.v1ArchiveRoot, "events.sqlite")), false);
  } finally { f.cleanup(); }
});

test("wrong partial store identity is rejected before recovering its manifest", async () => {
  const f = freshInitializationFixture();
  try {
    const { FreshStartInitializer } = await implementation();
    await assert.rejects(new FreshStartInitializer({ ...f.dependencies, faultInjector: { hit: (at: string) => {
      if (at === "after-database-publish-before-manifest") throw new Error("owned interruption");
    } } }).initializeFresh(f.input), /owned interruption/);
    const journal = JSON.parse(readFileSync(f.journalPath, "utf8"));
    unlinkSync(f.databasePath);
    const database = new NodeSqliteDriver({ DatabaseSync }).open(f.databasePath, { mode: "create", busyTimeoutMs: 5_000 });
    try { applyCurrentProjectStoreSchema(database, { ...journal.identity, storeId: randomUUID() }, f.input.release.createdAt); }
    finally { database.close(); }
    await assert.rejects(new FreshStartInitializer(f.dependencies).resumeInitialization(f.input), { code: "FRESH_START_IDENTITY_MISMATCH" });
    assert.equal(existsSync(join(f.input.v2VaultRoot, ".memory-mcp", "v2", "store-manifest.json")), false);
  } finally { f.cleanup(); }
});

test("missing published database before manifest recovery never recreates storage", async () => {
  const f = freshInitializationFixture();
  try {
    const { FreshStartInitializer } = await implementation();
    await assert.rejects(new FreshStartInitializer({ ...f.dependencies, faultInjector: { hit: (at: string) => {
      if (at === "after-database-publish-before-manifest") throw new Error("owned interruption");
    } } }).initializeFresh(f.input), /owned interruption/);
    unlinkSync(f.databasePath);
    await assert.rejects(new FreshStartInitializer(f.dependencies).resumeInitialization(f.input), { code: "FRESH_START_RECOVERY_REQUIRED" });
    assert.equal(existsSync(f.databasePath), false);
  } finally { f.cleanup(); }
});

test("resume rejects changed build artifact, release, actor, malformed journal and foreign partial files", async () => {
  const f = freshInitializationFixture();
  try {
    const { FreshStartInitializer } = await implementation();
    await assert.rejects(new FreshStartInitializer({ ...f.dependencies, faultInjector: { hit: (at: string) => {
      if (at === "after-journal-reserved") throw new Error("owned interruption");
    } } }).initializeFresh(f.input), /owned interruption/);
    await assert.rejects(new FreshStartInitializer({ ...f.dependencies, actorFingerprint: "a".repeat(64) }).resumeInitialization(f.input), { code: "FRESH_START_JOURNAL_MISMATCH" });
    await assert.rejects(new FreshStartInitializer(f.dependencies).resumeInitialization({ ...f.input, release: { ...f.input.release, releaseId: randomUUID() } }), { code: "FRESH_START_JOURNAL_MISMATCH" });
    writeFileSync(join(f.input.v2VaultRoot, "foreign.txt"), "unowned");
    await assert.rejects(new FreshStartInitializer(f.dependencies).resumeInitialization(f.input), { code: "FRESH_START_DESTINATION_NOT_EMPTY" });
    writeFileSync(f.artifact, "changed build");
    await assert.rejects(new FreshStartInitializer(f.dependencies).resumeInitialization(f.input), { code: "FRESH_START_RELEASE_MISMATCH" });
    const journal = JSON.parse(readFileSync(f.journalPath, "utf8"));
    writeFileSync(f.journalPath, JSON.stringify({ ...journal, operatorApproved: true }));
    await assert.rejects(new FreshStartInitializer(f.dependencies).resumeInitialization(f.input), { code: "FRESH_START_JOURNAL_MISMATCH" });
  } finally { f.cleanup(); }
});

test("fresh may create an absent destination but ordinary open never creates it", async () => {
  const f = freshInitializationFixture();
  try {
    const { FreshStartInitializer } = await implementation();
    rmdirSync(f.input.v2VaultRoot);
    await assert.rejects(new FreshStartInitializer().openExisting(f.input), { code: "FRESH_START_RECOVERY_REQUIRED" });
    assert.equal(existsSync(f.input.v2VaultRoot), false);
    const receipt = await new FreshStartInitializer(f.dependencies).initializeFresh(f.input);
    assert.equal(receipt.semanticPosition, "0");
    assert.equal(existsSync(f.databasePath), true);
  } finally { f.cleanup(); }
});

test("unverified projection changes cannot be turned into a receipt by resume", async () => {
  const f = freshInitializationFixture();
  try {
    const { FreshStartInitializer } = await implementation();
    await assert.rejects(new FreshStartInitializer({ ...f.dependencies, faultInjector: { hit: (at: string) => {
      if (at === "after-projection-verified") throw new Error("owned interruption");
    } } }).initializeFresh(f.input), /owned interruption/);
    const journal = JSON.parse(readFileSync(f.journalPath, "utf8"));
    const projection = join(journal.storeRoot, "fresh-start-projection", journal.projection.databaseFile);
    writeFileSync(projection, "corrupt owned projection bytes");
    await assert.rejects(new FreshStartInitializer(f.dependencies).resumeInitialization(f.input));
    const database = new DatabaseSync(f.databasePath, { readOnly: true });
    try { assert.equal(database.prepare("SELECT count(*) AS count FROM fresh_start_installation").get()!.count, 0); }
    finally { database.close(); }
    await assert.rejects(new FreshStartInitializer().openExisting(f.input), { code: "FRESH_START_RECOVERY_REQUIRED" });
  } finally { f.cleanup(); }
});

test("resume refuses foreign content nested inside the reserved routed store", async () => {
  const f = freshInitializationFixture();
  try {
    const { FreshStartInitializer } = await implementation();
    await assert.rejects(new FreshStartInitializer({ ...f.dependencies, faultInjector: { hit: (at: string) => {
      if (at === "after-store-published") throw new Error("owned interruption");
    } } }).initializeFresh(f.input), /owned interruption/);
    const journal = JSON.parse(readFileSync(f.journalPath, "utf8"));
    const foreign = join(journal.storeRoot, "foreign.txt");
    writeFileSync(foreign, "keep foreign content");
    await assert.rejects(new FreshStartInitializer(f.dependencies).resumeInitialization(f.input), { code: "FRESH_START_DESTINATION_NOT_EMPTY" });
    assert.equal(readFileSync(foreign, "utf8"), "keep foreign content");
  } finally { f.cleanup(); }
});
