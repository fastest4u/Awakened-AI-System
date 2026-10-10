import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { NodeSqliteDriver } from "../src/orchestrator/storage/node-sqlite-driver.js";
import { MaintenanceFence } from "../src/orchestrator/storage/maintenance-fence.js";
import { FreshStartControlPlane } from "../src/orchestrator/fresh-start/fresh-start-control-plane.js";
import { DENY_FRESH_START_PROMOTION } from "../src/orchestrator/fresh-start/operator-approval.js";
import { FreshStartError, decodeFreshStartGenesis, type FreshStartGenesis } from "../src/orchestrator/fresh-start/contracts.js";
import { FreshStartInitializer } from "../src/orchestrator/fresh-start/fresh-start-initializer.js";
import { SqliteFreshStartRepository } from "../src/orchestrator/fresh-start/fresh-start.repository.js";
import * as manifests from "../src/orchestrator/projections/manifest-codec.js";
import type { ProjectBinding } from "../src/orchestrator/projections/contracts.js";
import { SqliteVerifiedReadAdmission } from "../src/orchestrator/verified-read/admission.js";
import { FRESH_IDENTITY, freshGenesis, freshRelease, freshStore, freshInitializationFixture } from "./support/fresh-start-fixture.js";
import { makeActiveReadFixture } from "./support/v2-verified-read-fixture.js";

// Literal frozen historical wire bytes: catches wrappers, reordered keys and changed domains.
const LEGACY_BYTES = '{"sessionTree":"094f95adbc258adaac29006702d7c170b05bfb7c48bc179c87dfdf45c5b25eb1","sessionCheckpoints":"c4fd78434b162789f38370ad7adda6466ffff60d49086198d05d43f49f893833","canonicalItems":"d00dd89e51551bc90722b7cfd33a94ef00d9781d23e944f1a8bb30376bee03d2","tasksFollowups":"3f10f2f173c0ef0d14bc02958fccf733ce57f43112717608e6abd67c35477a71","artifactsFiles":"9749469934e636fd3f2abcd1058a1091ba689719accf90bc714db96e0206b476","entityGraph":"dad5933d16c209e758a36a5ef33619363b6a242f154bfdc2b2898ec5a315ee60","lexicalChunks":"46fdefda37bee1b273dc3eea210d7d2ae7c437d749bacc322b259824cdc1ea1f","retrievalFeedback":"9531d113a8d6450b8d4235eea1e3ac55c9ff6694d29110dd9a54542200210901"}';
const NAMES = ["sessionTree", "sessionCheckpoints", "canonicalItems", "tasksFollowups", "artifactsFiles", "entityGraph", "lexicalChunks", "retrievalFeedback", "governedNotes"];
// Independent canonical empty vector, without production checksum/codec helpers.
function empty3(projectId: string) {
  return Object.fromEntries(NAMES.map(name => [name, createHash("sha256")
    .update("project-memory/projection-core/v1\n" + JSON.stringify([name, 3, projectId, "0", []])).digest("hex")]));
}
function v2(base = freshGenesis()) {
  return { ...base, genesisVersion: 2, projectionSchemaVersion: 3, projectionChecksums: empty3(base.projectId) };
}
type Codec = {
  decodeFreshStartGenesis(value: unknown): FreshStartGenesis;
  encodeStoredGenesisChecksums(value: FreshStartGenesis): string;
  decodeStoredGenesisChecksums(value: string): { genesisVersion: number; projectionSchemaVersion: number; projectionChecksums: Readonly<Record<string, string>> };
  FreshStartError: typeof FreshStartError;
};
async function codec(): Promise<Codec> {
  const path = "../src/orchestrator/fresh-start/genesis-codec.js";
  let loaded: Partial<Codec> = {};
  try { loaded = await import(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ERR_MODULE_NOT_FOUND") throw error; }
  assert.equal(typeof loaded.encodeStoredGenesisChecksums, "function", "shared genesis codec must encode both storage profiles");
  return loaded as Codec;
}
type RichParser = (value: unknown, binding: ProjectBinding) => manifests.ProjectionManifestV2 | manifests.ProjectionManifestV3;
function parser(name: "parseProjectionManifestV3" | "parseRichProjectionManifest"): RichParser {
  const fn = (manifests as unknown as Record<string, unknown>)[name];
  assert.equal(typeof fn, "function", `${name} must parse actual schema3 metadata`);
  return fn as RichParser;
}
function manifest3(binding: ProjectBinding) {
  return { schemaVersion: 3, ...binding, generation: 2, highestObservedGeneration: 2,
    terminalEventPosition: "0", terminalEventHash: "0".repeat(64), databaseFile: "projections-3-2.sqlite",
    databaseSha256: "a".repeat(64), coreChecksums: empty3(binding.projectId), createdAt: "2026-10-09T00:00:00.000Z" };
}

test("legacy_genesis_bytes_are_unchanged", async () => {
  const c = await codec();
  const legacy = c.decodeFreshStartGenesis(freshGenesis());
  assert.equal(Object.keys(legacy).length, 11);
  assert.equal(c.encodeStoredGenesisChecksums(legacy), LEGACY_BYTES);
  assert.deepEqual(c.decodeStoredGenesisChecksums(LEGACY_BYTES), { genesisVersion: 1, projectionSchemaVersion: 2, projectionChecksums: JSON.parse(LEGACY_BYTES) });
  assert.equal(c.FreshStartError, FreshStartError);
  assert.equal(c.decodeFreshStartGenesis, decodeFreshStartGenesis);
  assert.throws(() => c.decodeFreshStartGenesis({}), error => error instanceof FreshStartError && error.code === "FRESH_START_INPUT_INVALID");
  const f = freshStore();
  try {
    const repository = new SqliteFreshStartRepository(f.connection);
    repository.transact(FRESH_IDENTITY, tx => tx.install(legacy, freshRelease()));
    assert.equal(f.connection.prepare("SELECT projection_checksums_json AS bytes FROM fresh_start_installation").get()!.bytes, LEGACY_BYTES);
    assert.deepEqual(repository.transact(FRESH_IDENTITY, tx => tx.installation()), legacy);
  } finally { f.cleanup(); }
});

test("v2_genesis_exact_envelope persists immutable truth without event-store schema changes", async () => {
  const c = await codec(), input = v2(), genesis = c.decodeFreshStartGenesis(input);
  assert.equal(Object.keys(genesis).length, 13);
  assert.equal(genesis.semanticPosition, "0"); assert.equal(genesis.terminalHash, "0".repeat(64));
  assert.equal(Object.keys(genesis.projectionChecksums).length, 9);
  assert.deepEqual(genesis, input);
  const envelope = { genesisVersion: 2, projectionSchemaVersion: 3, projectionChecksums: input.projectionChecksums };
  assert.equal(c.encodeStoredGenesisChecksums(genesis), JSON.stringify(envelope));
  assert.deepEqual(c.decodeStoredGenesisChecksums(JSON.stringify(envelope)), envelope);
  input.projectionChecksums.sessionTree = "f".repeat(64);
  assert.notEqual(genesis.projectionChecksums.sessionTree, input.projectionChecksums.sessionTree);
  assert.ok(Object.isFrozen(genesis) && Object.isFrozen(genesis.projectionChecksums));
  const f = freshStore();
  try {
    const schema = () => f.connection.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all();
    const before = schema(), repository = new SqliteFreshStartRepository(f.connection);
    repository.transact(FRESH_IDENTITY, tx => tx.install(genesis, freshRelease()));
    assert.deepEqual(repository.transact(FRESH_IDENTITY, tx => tx.installation()), genesis);
    const bytes = f.connection.prepare("SELECT projection_checksums_json AS bytes FROM fresh_start_installation").get()!.bytes;
    assert.equal(bytes, c.encodeStoredGenesisChecksums(genesis));
    assert.throws(() => f.connection.exec("UPDATE fresh_start_installation SET projection_checksums_json = '{}'"));
    assert.deepEqual(schema(), before);
    assert.equal(f.connection.prepare("SELECT count(*) AS n FROM events").get()!.n, 0n);
  } finally { f.cleanup(); }
});

test("full and stored genesis refuse mixed discriminants, tampered checksums, descriptors and changed identity domains", async () => {
  const c = await codec(), base = v2();
  for (const input of [
    { ...base, genesisVersion: 1 }, { ...base, projectionSchemaVersion: 2 }, { ...base, genesisVersion: 3 },
    { ...freshGenesis(), genesisVersion: 2 }, { ...freshGenesis(), projectionSchemaVersion: 3 },
    { ...base, extra: true }, { ...base, semanticPosition: "00" }, { ...base, semanticPosition: "1" },
    { ...base, terminalHash: "a".repeat(64) }, { ...base, projectId: "a".repeat(64) },
    { ...base, projectionChecksums: { ...JSON.parse(LEGACY_BYTES), governedNotes: base.projectionChecksums.governedNotes } },
    { ...base, projectionChecksums: { ...base.projectionChecksums, sessionTree: "f".repeat(64) } },
    { ...base, projectionChecksums: { ...base.projectionChecksums, governedNotes: "f".repeat(64) } },
    { ...base, projectionChecksums: JSON.parse(LEGACY_BYTES) }, { ...freshGenesis(), projectionChecksums: base.projectionChecksums },
  ]) assert.throws(() => c.decodeFreshStartGenesis(input), { code: "FRESH_START_INPUT_INVALID" });
  for (const key of Object.keys(base)) {
    const missing = { ...base } as Record<string, unknown>; delete missing[key];
    assert.throws(() => c.decodeFreshStartGenesis(missing), { code: "FRESH_START_INPUT_INVALID" });
  }
  let accessed = 0;
  for (const key of ["genesisVersion", "projectionSchemaVersion", "projectionChecksums"]) {
    const getter = Object.defineProperty({ ...base }, key, { enumerable: true, get() { accessed++; return 2; } });
    assert.throws(() => c.decodeFreshStartGenesis(getter), { code: "FRESH_START_INPUT_INVALID" });
    assert.throws(() => c.decodeFreshStartGenesis(Object.defineProperty({ ...base }, key, { enumerable: false })), { code: "FRESH_START_INPUT_INVALID" });
  }
  assert.equal(accessed, 0);
  assert.throws(() => c.decodeFreshStartGenesis({ ...base, [Symbol("extra")]: true }), { code: "FRESH_START_INPUT_INVALID" });
  const envelope = { genesisVersion: 2, projectionSchemaVersion: 3, projectionChecksums: base.projectionChecksums };
  for (const stored of [base.projectionChecksums, { ...envelope, extra: true }, { ...envelope, genesisVersion: 1 },
    { ...envelope, projectionSchemaVersion: 2 }, { genesisVersion: 2, projectionChecksums: base.projectionChecksums },
    { ...envelope, projectionChecksums: JSON.parse(LEGACY_BYTES) }]) {
    assert.throws(() => c.decodeStoredGenesisChecksums(JSON.stringify(stored)), { code: "FRESH_START_INPUT_INVALID" });
  }
  assert.throws(() => c.decodeStoredGenesisChecksums("{"), { code: "FRESH_START_INPUT_INVALID" });
});

test("pure rich manifest parsers own exact schema3 metadata and preserve schema2/imported identity domains", () => {
  const scope = { ...FRESH_IDENTITY, workspaceId: "a".repeat(64), branchScopeId: null, branchRef: null, sessionId: null } as ProjectBinding;
  const input = manifest3(scope), parse3 = parser("parseProjectionManifestV3"), rich = parser("parseRichProjectionManifest");
  const parsed = parse3(input, scope);
  assert.equal(parsed.schemaVersion, 3);
  if (parsed.schemaVersion !== 3) assert.fail("schema3 parser returned a different profile");
  assert.equal(Object.keys(parsed).length, 16); assert.deepEqual(rich(input, scope), parsed);
  input.coreChecksums.governedNotes = "b".repeat(64);
  assert.notEqual(parsed.coreChecksums.governedNotes, input.coreChecksums.governedNotes);
  assert.ok(Object.isFrozen(parsed) && Object.isFrozen(parsed.coreChecksums));
  const two = { ...manifest3(scope), schemaVersion: 2, databaseFile: "projections-2-2.sqlite", coreChecksums: JSON.parse(LEGACY_BYTES) };
  assert.equal(rich(two, scope).schemaVersion, 2);
  assert.throws(() => manifests.parseProjectionManifestV2(manifest3(scope), scope));
  assert.throws(() => parse3(two, scope));
  assert.throws(() => manifests.parseProjectionManifestForPublication(manifest3(scope), scope));
  for (const wrong of [{ schemaVersion: 1 }, { schemaVersion: 4 }, { databaseFile: "projections-2-2.sqlite" },
    { highestObservedGeneration: 1 }, { generation: 0 }, { generation: 2147483648 }, { highestObservedGeneration: 2147483648 },
    { terminalEventPosition: "00" }, { terminalEventPosition: "9223372036854775808" }, { sessionId: FRESH_IDENTITY.projectId },
    { createdAt: "2026-10-09" }, { coreChecksums: JSON.parse(LEGACY_BYTES) }, { extra: true }]) {
    assert.throws(() => rich({ ...manifest3(scope), ...wrong }, scope));
  }
  let accessed = 0;
  assert.throws(() => rich(Object.defineProperty(manifest3(scope), "schemaVersion", { get() { accessed++; return 3; } }), scope));
  assert.equal(accessed, 0);
  const imported = { ...scope, projectId: "c".repeat(64), vaultId: "d".repeat(64), storeId: "e".repeat(64),
    branchScopeId: "11111111-1111-1111-8111-111111111111", branchRef: "refs/heads/test" } as ProjectBinding;
  assert.equal(parse3(manifest3(imported), imported).projectId, imported.projectId);
});

for (const profile of [1, 2]) test(`genesis_profile_does_not_override_admission (${profile})`, async () => {
  const c = await codec(), f = await makeActiveReadFixture();
  try {
    if (profile === 2) {
      // Owned fixture conversion before assertions; production installation immutability is separately tested.
      const trigger = f.writer.prepare("SELECT sql FROM sqlite_schema WHERE name = 'fresh_start_installation_no_update'").get()!.sql as string;
      f.writer.exec("DROP TRIGGER fresh_start_installation_no_update");
      try { f.writer.prepare("UPDATE fresh_start_installation SET projection_checksums_json = $value")
        .run({ $value: c.encodeStoredGenesisChecksums(c.decodeFreshStartGenesis(v2())) }); }
      finally { f.writer.exec(trigger); }
    }
    const admission = new SqliteVerifiedReadAdmission(f.reader, f.binding, f.measuredBuildHash);
    const fence = admission.capture(f.request), image = parser("parseProjectionManifestV3")(manifest3(f.binding.projectionBinding), f.binding.projectionBinding);
    // Metadata admission positive only: no claim of a built/captured schema3 SQLite image.
    admission.revalidate(fence, image);
    assert.equal(f.reader.prepare("SELECT total_changes() AS n").get()!.n, 0n);
    const closed = () => { f.reader.exec("BEGIN"); f.reader.exec("ROLLBACK"); };
    closed();
    assert.throws(() => admission.revalidate({ ...fence, controlGeneration: "2" }, image), { code: "FRESH_START_ADMISSION_STALE" }); closed();
    assert.throws(() => admission.revalidate(fence, { ...image, terminalEventHash: "f".repeat(64) }), { message: "INTEGRITY_FAILURE" }); closed();
    assert.throws(() => admission.revalidate(fence, { ...image, terminalEventPosition: "1" }), { message: "INTEGRITY_FAILURE" }); closed();
    assert.throws(() => admission.revalidate({ ...fence, requiredPosition: "1" }, image), { message: "PROJECTION_LAG" }); closed();
    for (const field of ["buildIdentityHash", "schemaIdentityHash", "configurationHash", "capabilityManifestHash", "recoveryPolicyHash", "evidenceDigest"] as const) {
      const wrong = new SqliteVerifiedReadAdmission(f.reader, { ...f.binding, expectedRelease: { ...f.release, [field]: "9".repeat(64) } }, f.measuredBuildHash);
      const code = field === "buildIdentityHash" ? "FRESH_START_BUILD_MISMATCH" : field === "schemaIdentityHash" ? "FRESH_START_SCHEMA_MISMATCH" : "FRESH_START_RELEASE_MISMATCH";
      assert.throws(() => wrong.revalidate(fence, image), { code }); closed();
    }
    f.control.stop({ identity: f.identity, expectedGeneration: 1n, target: "read-only-recovery", reasonCode: "integrity-failure" });
    assert.throws(() => admission.revalidate(fence, image), { code: "FRESH_START_CONTENT_UNVERIFIED" }); closed();
    await f.control.transition({ identity: f.identity, expectedGeneration: 2n, expectedMode: "read-only-recovery",
      expectedReleaseId: f.release.releaseId, nextMode: "active", nextRelease: f.release, approvalEnvelope: new Uint8Array([1]) });
    assert.throws(() => admission.revalidate(fence, image), { code: "FRESH_START_ADMISSION_STALE" }); closed();
    f.control.stop({ identity: f.identity, expectedGeneration: 3n, target: "disabled", reasonCode: "integrity-failure" });
    assert.throws(() => admission.revalidate(fence, image), { code: "FRESH_START_ADMISSION_DENIED" }); closed();
    await f.control.transition({ identity: f.identity, expectedGeneration: 4n, expectedMode: "disabled",
      expectedReleaseId: f.release.releaseId, nextMode: "prepared", nextRelease: f.release, approvalEnvelope: new Uint8Array([1]) });
    assert.throws(() => admission.revalidate(fence, image), { code: "FRESH_START_ADMISSION_DENIED" }); closed();
    const deniedControl = new FreshStartControlPlane(f.repository, DENY_FRESH_START_PROMOTION, DENY_FRESH_START_PROMOTION);
    await assert.rejects(deniedControl.transition({ identity: f.identity, expectedGeneration: 5n, expectedMode: "prepared",
      expectedReleaseId: f.release.releaseId, nextMode: "active", nextRelease: f.release, approvalEnvelope: new Uint8Array([1]) }),
    { code: "FRESH_START_RELEASE_NOT_READY" });
  } finally { f.cleanup(); }
});

test("V2 genesis preserves owning append maintenance fence and stored corruption is a safe failure in both consumers", async () => {
  const c = await codec(), f = await makeActiveReadFixture();
  try {
    const trigger = f.writer.prepare("SELECT sql FROM sqlite_schema WHERE name = 'fresh_start_installation_no_update'").get()!.sql as string;
    function replace(value: string) {
      f.writer.exec("DROP TRIGGER fresh_start_installation_no_update");
      try { f.writer.prepare("UPDATE fresh_start_installation SET projection_checksums_json = $value").run({ $value: value }); }
      finally { f.writer.exec(trigger); }
    }
    const genesis = c.decodeFreshStartGenesis(v2());
    replace(c.encodeStoredGenesisChecksums(genesis));
    new MaintenanceFence().acquire(f.writer, "owned-maintenance", "2026-09-29T00:01:00.000Z", "2026-09-29T00:00:00.000Z");
    assert.throws(() => f.append(), { code: "MAINTENANCE_QUIESCING" });
    assert.equal(f.writer.prepare("SELECT count(*) AS n FROM events").get()!.n, 0n);
    const admission = new SqliteVerifiedReadAdmission(f.reader, f.binding, f.measuredBuildHash);
    for (const value of ["{}", JSON.stringify({ genesisVersion: 2, projectionSchemaVersion: 3,
      projectionChecksums: { ...genesis.projectionChecksums, sessionTree: "f".repeat(64) } })]) {
      replace(value);
      assert.throws(() => f.repository.transact(f.identity, tx => tx.installation()), { code: "FRESH_START_STORAGE_FAILURE" });
      assert.throws(() => admission.capture(f.request), { code: "FRESH_START_STORAGE_FAILURE" });
      f.reader.exec("BEGIN"); f.reader.exec("ROLLBACK");
    }
  } finally { f.cleanup(); }
});

test("journal1 round trip keeps legacy receipt bytes and refuses mixed V2 receipt", async () => {
  const f = freshInitializationFixture();
  try {
    const initializer = new FreshStartInitializer(f.dependencies), receipt = await initializer.initializeFresh(f.input);
    const before = readFileSync(f.journalPath, "utf8"), journal = JSON.parse(before);
    assert.equal(journal.version, 1); assert.equal(Object.keys(journal.receipt).length, 11);
    assert.equal(journal.projection.schemaVersion, 2);
    assert.deepEqual(await initializer.openExisting(f.input), receipt);
    assert.equal(readFileSync(f.journalPath, "utf8"), before);
    writeFileSync(f.journalPath, JSON.stringify({ ...journal, receipt: v2(receipt) }));
    await assert.rejects(initializer.openExisting(f.input), { code: "FRESH_START_JOURNAL_MISMATCH" });
  } finally { f.cleanup(); }
});

test("journal2 decode/openExisting round trip binds its V2 receipt and schema3 metadata without creating a schema3 image", async () => {
  const c = await codec(), f = freshInitializationFixture();
  try {
    const initializer = new FreshStartInitializer(f.dependencies), legacy = await initializer.initializeFresh(f.input);
    const original = JSON.parse(readFileSync(f.journalPath, "utf8"));
    const receipt = c.decodeFreshStartGenesis(v2(legacy));
    const connection = new NodeSqliteDriver({ DatabaseSync }).open(f.databasePath, { mode: "existing", busyTimeoutMs: 1000 });
    try {
      const sql = connection.prepare("SELECT sql FROM sqlite_schema WHERE name = 'fresh_start_installation_no_update'").get()!.sql as string;
      connection.exec("DROP TRIGGER fresh_start_installation_no_update");
      try { connection.prepare("UPDATE fresh_start_installation SET projection_checksums_json = $value").run({ $value: c.encodeStoredGenesisChecksums(receipt) }); }
      finally { connection.exec(sql); }
    } finally { connection.close(); }
    const { projectId, vaultId, storeId, workspaceId, branchScopeId, branchRef, sessionId } = original.projection;
    const journal = { ...original, version: 2, projectionSchemaVersion: 3, receipt,
      projection: manifest3({ projectId, vaultId, storeId, workspaceId, branchScopeId, branchRef, sessionId }) };
    const bytes = JSON.stringify(journal) + "\n";
    writeFileSync(f.journalPath, bytes);
    assert.deepEqual(await initializer.openExisting(f.input), receipt);
    assert.equal(readFileSync(f.journalPath, "utf8"), bytes);
    for (const wrong of [ { projectionSchemaVersion: 2 }, { version: 1 }, { receipt: legacy },
      { projection: original.projection }, { projection: { ...journal.projection, coreChecksums: { ...journal.projection.coreChecksums, sessionTree: "f".repeat(64) } } } ]) {
      writeFileSync(f.journalPath, JSON.stringify({ ...journal, ...wrong }));
      await assert.rejects(initializer.openExisting(f.input), { code: "FRESH_START_JOURNAL_MISMATCH" });
    }
    writeFileSync(f.journalPath, JSON.stringify({ ...journal, phase: "reserved", receipt: null, projection: null, foundationChecksDigest: null }));
    await assert.rejects(initializer.resumeInitialization(f.input), { code: "FRESH_START_RECOVERY_REQUIRED" });
  } finally { f.cleanup(); }
});
