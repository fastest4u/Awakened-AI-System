import assert from "node:assert/strict";
import { copyFileSync, lstatSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import { makeActiveReadFixture, readAdmissionConstructor } from "./support/v2-verified-read-fixture.js";
import type { SqliteConnection } from "../src/orchestrator/storage/sqlite-driver.js";
import { NodeSqliteDriver } from "../src/orchestrator/storage/node-sqlite-driver.js";
import { FreshStartAdmissionGuard } from "../src/orchestrator/fresh-start/fresh-start-admission.js";
import { GENESIS_GLOBAL_HASH } from "../src/orchestrator/storage/event-append-transaction.js";

async function fixture(measuredBuildHash?: string) {
  assert.equal(typeof await readAdmissionConstructor(), "function", "Task 3 must supply real verified-read admission");
  return makeActiveReadFixture(measuredBuildHash);
}
function closed(reader: SqliteConnection): void { reader.exec("BEGIN"); reader.exec("ROLLBACK"); }
function corrupt(writer: SqliteConnection, trigger: string, sql: string): void {
  const definition = writer.prepare("SELECT sql FROM sqlite_schema WHERE name = $name").get({ $name: trigger })!.sql as string;
  writer.exec(`DROP TRIGGER ${trigger}`);
  try { writer.exec(sql); } finally { writer.exec(definition); }
}

it("captures empty genesis with closed read snapshots and no authoritative writes", async () => {
  const f = await fixture();
  try {
    const before = f.writer.prepare("SELECT total_changes() AS changes").get()!.changes;
    const fence = f.admission.capture(f.request);
    assert.deepEqual(fence, { controlGeneration: "1", releaseId: f.release.releaseId,
      capturedPosition: "0", capturedHash: GENESIS_GLOBAL_HASH, requiredPosition: "0" });
    closed(f.reader);
    f.admission.revalidate(fence, f.manifest); closed(f.reader);
    assert.equal(f.reader.prepare("SELECT total_changes() AS changes").get()!.changes, 0n);
    assert.equal(f.writer.prepare("SELECT total_changes() AS changes").get()!.changes, before);
    assert.equal(f.writer.prepare("SELECT count(*) AS n FROM events").get()!.n, 0n);
    assert.equal(f.writer.prepare("SELECT count(*) AS n FROM fresh_start_installation").get()!.n, 1n);
    assert.equal(f.writer.prepare("SELECT generation FROM fresh_start_control_state").get()!.generation, 1n);
    assert.equal(f.writer.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()!.busy, 0n);
  } finally { f.cleanup(); }
});

it("conservatively captures the project tail and permits later ordinary commits", async () => {
  const f = await fixture();
  try {
    const first = f.append(); const fence = f.admission.capture(f.request); closed(f.reader);
    assert.equal(fence.capturedPosition, "1"); assert.equal(fence.capturedHash, first.hash); assert.equal(fence.requiredPosition, "1");
    const manifest = await f.publish(); f.append();
    f.admission.revalidate(fence, manifest); closed(f.reader);
    assert.equal(f.writer.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()!.busy, 0n);
  } finally { f.cleanup(); }
});

it("retains a captured anchor separately from the session and request minimum", async () => {
  const f = await fixture();
  try {
    const Admission = (await readAdmissionConstructor())!;
    const admission = new Admission(f.reader, { ...f.binding, session: { sessionId: "66666666-6666-4666-8666-666666666666", minimumEventPosition: "2" } }, f.measuredBuildHash);
    const fence = admission.capture({ ...f.request, consistency: "session-strong", minimumEventPosition: "3", budgetMs: 2000 });
    assert.equal(fence.capturedPosition, "0"); assert.equal(fence.requiredPosition, "3"); closed(f.reader);
    assert.throws(() => admission.revalidate(fence, f.manifest), { message: "PROJECTION_LAG" }); closed(f.reader);
    f.append(); f.append(); f.append(); admission.revalidate(fence, await f.publish()); closed(f.reader);
  } finally { f.cleanup(); }
});

for (const empty of [true, false]) it(`recovery denies before stale generation (${empty ? "empty" : "nonempty"} store)`, async () => {
  const f = await fixture();
  try {
    if (!empty) f.append();
    const fence = f.admission.capture(f.request); const manifest = await f.publish();
    f.control.stop({ identity: f.identity, expectedGeneration: 1n, target: "read-only-recovery", reasonCode: "integrity-failure" });
    assert.throws(() => f.admission.capture(f.request), { code: "FRESH_START_CONTENT_UNVERIFIED" }); closed(f.reader);
    assert.throws(() => f.admission.revalidate(fence, manifest), { code: "FRESH_START_CONTENT_UNVERIFIED" }); closed(f.reader);
  } finally { f.cleanup(); }
});

for (const target of ["disabled", "prepared"] as const) it(`${target} denies without opening a writer transaction`, async () => {
  const f = await fixture();
  try {
    const fence = f.admission.capture(f.request);
    f.control.stop({ identity: f.identity, expectedGeneration: 1n, target: "disabled", reasonCode: "integrity-failure" });
    if (target === "prepared") await f.control.transition({ identity: f.identity, expectedGeneration: 2n, expectedMode: "disabled",
      expectedReleaseId: f.release.releaseId, nextMode: "prepared", nextRelease: f.release, approvalEnvelope: new Uint8Array([1]) });
    assert.throws(() => f.admission.capture(f.request), { code: "FRESH_START_ADMISSION_DENIED" }); closed(f.reader);
    assert.throws(() => f.admission.revalidate(fence, f.manifest), { code: "FRESH_START_ADMISSION_DENIED" }); closed(f.reader);
  } finally { f.cleanup(); }
});

it("a renewed active generation invalidates the captured authority", async () => {
  const f = await fixture();
  try {
    const fence = f.admission.capture(f.request);
    f.control.stop({ identity: f.identity, expectedGeneration: 1n, target: "read-only-recovery", reasonCode: "integrity-failure" });
    await f.control.transition({ identity: f.identity, expectedGeneration: 2n, expectedMode: "read-only-recovery",
      expectedReleaseId: f.release.releaseId, nextMode: "active", nextRelease: f.release, approvalEnvelope: new Uint8Array([1]) });
    assert.throws(() => f.admission.revalidate(fence, f.manifest), { code: "FRESH_START_ADMISSION_STALE" }); closed(f.reader);
  } finally { f.cleanup(); }
});

for (const field of ["buildIdentityHash", "schemaIdentityHash", "configurationHash", "capabilityManifestHash", "recoveryPolicyHash", "evidenceDigest", "releaseId"] as const)
  it(`compares trusted release ${field} against stored authority`, async () => {
    const f = await fixture();
    try {
      const Admission = (await readAdmissionConstructor())!;
      const wrong = field === "releaseId" ? "77777777-7777-4777-8777-777777777777" : "9".repeat(64);
      const admission = new Admission(f.reader, { ...f.binding, expectedRelease: { ...f.release, [field]: wrong } }, f.measuredBuildHash);
      const code = field === "buildIdentityHash" ? "FRESH_START_BUILD_MISMATCH" : field === "schemaIdentityHash" ? "FRESH_START_SCHEMA_MISMATCH" : "FRESH_START_RELEASE_MISMATCH";
      assert.throws(() => admission.capture(f.request), { code }); closed(f.reader);
      const fence = f.admission.capture(f.request);
      if (field === "releaseId") {
        f.control.stop({ identity: f.identity, expectedGeneration: 1n, target: "disabled", reasonCode: "integrity-failure" });
        const nextRelease = { ...f.release, releaseId: wrong };
        await f.control.transition({ identity: f.identity, expectedGeneration: 2n, expectedMode: "disabled",
          expectedReleaseId: f.release.releaseId, nextMode: "prepared", nextRelease, approvalEnvelope: new Uint8Array([1]) });
        await f.control.transition({ identity: f.identity, expectedGeneration: 3n, expectedMode: "prepared",
          expectedReleaseId: wrong, nextMode: "active", nextRelease, approvalEnvelope: new Uint8Array([1]) });
      } else {
        const columns = { buildIdentityHash: "build_identity_hash", schemaIdentityHash: "schema_identity_hash", configurationHash: "configuration_hash",
          capabilityManifestHash: "capability_manifest_hash", recoveryPolicyHash: "recovery_policy_hash", evidenceDigest: "evidence_digest" };
        corrupt(f.writer, "fresh_start_releases_no_update", `UPDATE fresh_start_releases SET ${columns[field]} = '${wrong}'`);
      }
      assert.throws(() => f.admission.revalidate(fence, f.manifest), { code }); closed(f.reader);
    } finally { f.cleanup(); }
  });

it("requires a trusted independent build measurement rather than echoing the release", async () => {
  const f = await fixture("7".repeat(64));
  try {
    const Admission = (await readAdmissionConstructor())!;
    assert.equal(f.admission.capture(f.request).requiredPosition, "0"); closed(f.reader);
    const admission = new Admission(f.reader, f.binding, "8".repeat(64));
    assert.throws(() => admission.capture(f.request), { code: "FRESH_START_BUILD_MISMATCH" }); closed(f.reader);
  } finally { f.cleanup(); }
});

it("inspects the actual schema despite an unchanged release schema hash", async () => {
  const f = await fixture();
  try {
    const fence = f.admission.capture(f.request); f.writer.exec("CREATE TABLE unexpected_schema_change(value TEXT)");
    assert.throws(() => f.admission.capture(f.request), { code: "FRESH_START_SCHEMA_MISMATCH" }); closed(f.reader);
    assert.throws(() => f.admission.revalidate(fence, f.manifest), { code: "FRESH_START_SCHEMA_MISMATCH" }); closed(f.reader);
    assert.equal(f.writer.prepare("SELECT schema_identity_hash FROM fresh_start_releases").get()!.schema_identity_hash, f.release.schemaIdentityHash);
  } finally { f.cleanup(); }
});

for (const table of ["project_meta", "fresh_start_installation", "fresh_start_control_state", "fresh_start_releases"])
  it(`checks stored vault/store identity in ${table}`, async () => {
    const f = await fixture();
    try {
      const fence = f.admission.capture(f.request);
      const trigger = table === "project_meta" ? "project_meta_identity_immutable" : table === "fresh_start_control_state" ? `${table}_sequence` : `${table}_no_update`;
      corrupt(f.writer, trigger, `UPDATE ${table} SET vault_id = '88888888-8888-4888-8888-888888888888'`);
      assert.throws(() => f.admission.revalidate(fence, f.manifest), { code: "FRESH_START_IDENTITY_MISMATCH" }); closed(f.reader);
    } finally { f.cleanup(); }
  });

for (const [field, update, ignoreChecks] of [
  ["recovery pair", "recovery_position = 1", true],
  ["recovery hash", "recovery_position = 0, recovery_hash = 'invalid'", true],
  ["last transition", "last_transition_id = 'invalid'", false],
  ["updated timestamp", "updated_at = '2026-10-01T00:00:00+00:00'", false],
] as const) it(`rejects a malformed stored control ${field} without retaining a snapshot`, async () => {
  const f = await fixture();
  try {
    const fence = f.admission.capture(f.request);
    // Pair/hash CHECK bypass is local to this owned corruption writer, never admission or host policy.
    if (ignoreChecks) f.writer.exec("PRAGMA ignore_check_constraints = ON");
    try { corrupt(f.writer, "fresh_start_control_state_sequence", `UPDATE fresh_start_control_state SET ${update}`); }
    finally { if (ignoreChecks) f.writer.exec("PRAGMA ignore_check_constraints = OFF"); }
    assert.throws(() => f.admission.capture(f.request), { code: "FRESH_START_STORAGE_FAILURE" }); closed(f.reader);
    assert.throws(() => f.admission.revalidate(fence, f.manifest), { code: "FRESH_START_STORAGE_FAILURE" }); closed(f.reader);
    if (field === "last transition") {
      corrupt(f.writer, "fresh_start_control_state_sequence", "UPDATE fresh_start_control_state SET last_transition_id = NULL");
      assert.throws(() => f.admission.capture(f.request), { code: "FRESH_START_STORAGE_FAILURE" }); closed(f.reader);
    }
  } finally { f.cleanup(); }
});

for (const which of ["captured", "image"] as const) it(`rejects a modified ${which} committed anchor`, async () => {
  const f = await fixture();
  try {
    f.append(); const fence = f.admission.capture(f.request); f.append(); const manifest = await f.publish(); f.append();
    corrupt(f.writer, "events_no_update", `UPDATE events SET event_hash = '${"9".repeat(64)}' WHERE global_position = ${which === "captured" ? 1 : 2}`);
    assert.throws(() => f.admission.revalidate(fence, manifest), { message: "INTEGRITY_FAILURE" }); closed(f.reader);
  } finally { f.cleanup(); }
});

it("rejects an image terminal beyond the authoritative tail and a mismatched genesis", async () => {
  const f = await fixture();
  try {
    const fence = f.admission.capture(f.request);
    assert.throws(() => f.admission.revalidate(fence, { ...f.manifest, terminalEventPosition: "1" }), { message: "INTEGRITY_FAILURE" }); closed(f.reader);
    assert.throws(() => f.admission.revalidate(fence, { ...f.manifest, terminalEventHash: "9".repeat(64) }), { message: "INTEGRITY_FAILURE" }); closed(f.reader);
  } finally { f.cleanup(); }
});

it("requires owner provenance on the exact connection rather than a wrapper", async () => {
  const f = await fixture();
  try {
    const Admission = (await readAdmissionConstructor())!;
    const wrapper: SqliteConnection = { exec: sql => f.reader.exec(sql), prepare: sql => f.reader.prepare(sql), close: () => undefined };
    const admission = new Admission(wrapper, f.binding, f.measuredBuildHash);
    assert.throws(() => admission.capture(f.request), { code: "FRESH_START_PATH_CHANGED" }); closed(f.reader);
  } finally { f.cleanup(); }
});

it("rejects a replaced authoritative pathname or observes native Windows prevention", async t => {
  const f = await fixture();
  try {
    const fence = f.admission.capture(f.request); const before = readFileSync(f.path);
    const old = join(f.root, "retained.sqlite"); let replaced = false;
    try { renameSync(f.path, old); replaced = true; }
    catch (error) {
      assert.ok(["EPERM", "EBUSY", "EACCES"].includes((error as { code: string }).code));
    }
    if (replaced) {
      copyFileSync(old, f.path);
      assert.throws(() => f.admission.revalidate(fence, f.manifest), { code: "FRESH_START_PATH_CHANGED" }); closed(f.reader);
      assert.notEqual(String(lstatSync(f.path, { bigint: true }).ino), f.binding.eventsFile.inode);
    } else {
      assert.deepEqual(readFileSync(f.path), before); t.diagnostic("Windows denied file rename; stale-handle replacement branch not exercised");
      f.admission.revalidate(fence, f.manifest); closed(f.reader);
    }
  } finally { f.cleanup(); }
});

it("capture observes one coherent snapshot across a separately committed control transition", async () => {
  const f = await fixture(); let observed: SqliteConnection | undefined;
  try {
    let stopped = false;
    class ObservedDatabase extends DatabaseSync {
      override prepare(sql: string) {
        const statement = super.prepare(sql); const get = statement.get.bind(statement);
        if (sql.includes("FROM fresh_start_installation")) statement.get = ((...params: Parameters<typeof statement.get>) => {
          const value = get(...params);
          if (!stopped) { stopped = true; f.control.stop({ identity: f.identity, expectedGeneration: 1n, target: "read-only-recovery", reasonCode: "integrity-failure" }); }
          return value;
        }) as typeof statement.get;
        return statement;
      }
    }
    observed = new NodeSqliteDriver({ DatabaseSync: ObservedDatabase }).open(f.path, { mode: "read-only-existing", bindFileIdentity: true, busyTimeoutMs: 1000 });
    const Admission = (await readAdmissionConstructor())!; const admission = new Admission(observed, f.binding, f.measuredBuildHash);
    const fence = admission.capture(f.request); assert.equal(fence.controlGeneration, "1"); assert.equal(stopped, true); closed(observed);
    assert.throws(() => admission.revalidate(fence, f.manifest), { code: "FRESH_START_CONTENT_UNVERIFIED" }); closed(observed);
  } finally { observed?.close(); f.cleanup(); }
});

it("does not weaken the public content-read denial", async () => {
  const f = await fixture();
  try {
    f.admission.revalidate(f.admission.capture(f.request), f.manifest);
    assert.throws(() => new FreshStartAdmissionGuard(f.writer).assertRequestAllowed({ identity: f.identity,
      releaseId: f.release.releaseId, generation: 1n, measuredBuildHash: f.measuredBuildHash, operation: "content-read" }), { code: "FRESH_START_CONTENT_UNVERIFIED" });
  } finally { f.cleanup(); }
});
