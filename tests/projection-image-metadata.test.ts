import assert from "node:assert/strict";
import { it } from "node:test";
import { ownedReadImage, readScope, READ_HASH } from "./support/v2-verified-read-fixture.js";
import { readProjectionImageMetadata, ProjectionImageMetadataError } from "../src/orchestrator/projections/image-metadata.js";
import { deserializableImage, openImmutableProjectionImage } from "../src/orchestrator/projections/immutable-image.js";

it("copies exact scalar metadata and SQLite int64 positions from a detached guarded image", async () => {
  const fixture = ownedReadImage();
  const database = openImmutableProjectionImage(fixture.bytes, 25);
  try {
    const metadata = readProjectionImageMetadata(database, fixture.manifest);
    assert.deepEqual(metadata, { schemaVersion: 2, ...readScope(), generation: 1,
      terminalEventPosition: "9223372036854775807", terminalEventHash: READ_HASH });
    assert.equal(Object.isFrozen(metadata), true);
    for (const [pragma, field, value] of [["query_only", "query_only", 1], ["trusted_schema", "trusted_schema", 0],
      ["foreign_keys", "foreign_keys", 1], ["busy_timeout", "timeout", 25]] as const) {
      assert.equal(database.prepare(`PRAGMA ${pragma}`).get()?.[field], value);
    }
    assert.throws(() => database.exec("DELETE FROM projection_metadata"));
    assert.deepEqual(database.prepare("SELECT count(*) AS n FROM temp.actual_vocab").get()?.n, 0);
  } finally { database.close(); }
});
const mismatches = [
  ["missing row", "DELETE FROM projection_metadata", "malformed"],
  ["singleton", "UPDATE projection_metadata SET singleton=2", "malformed"],
  ["extra singleton", "INSERT INTO projection_metadata SELECT 2, schema_version, project_id, vault_id, store_id, workspace_id, branch_scope_id, branch_ref, session_id, generation, terminal_event_position, terminal_event_hash FROM projection_metadata", "malformed"],
  ["schema", "UPDATE projection_metadata SET schema_version=1", "malformed"],
  ["generation", "UPDATE projection_metadata SET generation=2", "scope-mismatch"],
  ["position", "UPDATE projection_metadata SET terminal_event_position=0", "scope-mismatch"],
  ["hash", "UPDATE projection_metadata SET terminal_event_hash='wrong'", "scope-mismatch"],
  ["scope", "UPDATE projection_metadata SET project_id='wrong'", "scope-mismatch"],
  ["vault", "UPDATE projection_metadata SET vault_id='wrong'", "scope-mismatch"],
  ["store", "UPDATE projection_metadata SET store_id='wrong'", "scope-mismatch"],
  ["workspace", "UPDATE projection_metadata SET workspace_id='wrong'", "scope-mismatch"],
  ["branch scope", "UPDATE projection_metadata SET branch_scope_id='wrong'", "scope-mismatch"],
  ["branch ref", "UPDATE projection_metadata SET branch_ref='wrong'", "scope-mismatch"],
  ["session", "UPDATE projection_metadata SET session_id='wrong'", "scope-mismatch"],
  ["malformed generation", "UPDATE projection_metadata SET generation='wrong'", "malformed"],
  ["negative generation", "UPDATE projection_metadata SET generation=-1", "malformed"],
  ["unsafe generation", "UPDATE projection_metadata SET generation=9223372036854775807", "malformed"],
  ["fractional generation", "UPDATE projection_metadata SET generation=1.5", "malformed"],
  ["malformed position", "UPDATE projection_metadata SET terminal_event_position='wrong'", "malformed"],
  ["negative position", "UPDATE projection_metadata SET terminal_event_position=-1", "malformed"],
  ["scope short circuits malformed generation", "UPDATE projection_metadata SET project_id='wrong', generation='wrong'", "scope-mismatch"],
  ["generation short circuits malformed position", "UPDATE projection_metadata SET generation=2, terminal_event_position='wrong'", "scope-mismatch"],
] as const;
for (const [name, sql, kind] of mismatches) {
  it(`refuses matching-SHA image with ${name}`, async () => {
    const fixture = ownedReadImage(sql);
    const database = openImmutableProjectionImage(fixture.bytes);
    try {
      assert.throws(() => readProjectionImageMetadata(database, fixture.manifest), (error: unknown) =>
        error instanceof ProjectionImageMetadataError && error.kind === kind);
    } finally { database.close(); }
  });
}
it("preserves V1 metadata validation and lets native SQL errors propagate", async () => {
  const fixture = ownedReadImage("UPDATE projection_metadata SET schema_version=1");
  const database = openImmutableProjectionImage(fixture.bytes);
  try {
    const manifest = { ...fixture.manifest, schemaVersion: 1 as const };
    assert.equal(readProjectionImageMetadata(database, manifest).schemaVersion, 1);
  } finally { database.close(); }
  assert.throws(() => readProjectionImageMetadata(database, fixture.manifest), error => !(error instanceof ProjectionImageMetadataError));
});
it("normalizes only the detached journal header copy", async () => {
  const fixture = ownedReadImage();
  fixture.bytes[18] = 2;
  fixture.bytes[19] = 2;
  const normalized = deserializableImage(fixture.bytes);
  assert.equal(normalized[18], 1);
  assert.equal(normalized[19], 1);
  assert.equal(fixture.bytes[18], 2);
  assert.equal(fixture.bytes[19], 2);
  const database = openImmutableProjectionImage(fixture.bytes);
  database.close();
  assert.throws(() => deserializableImage(Uint8Array.of(0)));
  fixture.bytes[18] = 0;
  assert.throws(() => deserializableImage(fixture.bytes));
});
