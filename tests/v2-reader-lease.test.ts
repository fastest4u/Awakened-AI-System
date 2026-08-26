import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";

import {
  ImmutableProjectionBuilder,
} from "../src/orchestrator/projections/builder.js";
import {
  V2ProjectionBuildCoordinator,
  type PublishedProjectionGenerationV2,
} from "../src/orchestrator/projections/coordinator.js";
import type { ProjectBinding } from "../src/orchestrator/projections/contracts.js";
import type {
  BranchScopeId,
  ProjectId,
  StoreId,
  VaultId,
  WorkspaceId,
} from "../src/orchestrator/identity/contracts.js";
import { SqliteProjectionEventReader } from "../src/orchestrator/projections/event-reader.js";
import { LifecycleError } from "../src/orchestrator/lifecycle/errors.js";
import { acquireProjectionManifestPublicationLease } from "../src/orchestrator/projections/manifest.js";
import {
  filesystemStableProjectionDirectoryOperations,
  type StableProjectionGenerationImage,
} from "../src/orchestrator/projections/stable-directory.js";
import {
  V2ProjectionReaderLeaseRegistry,
  type LeasableV2ProjectionGeneration,
} from "../src/orchestrator/projections/v2-reader-lease.js";
import { PROJECT_MEMORY_APPLICATION_ID } from "../src/orchestrator/runtime/runtime-capabilities.js";
import { NodeSqliteDriver } from "../src/orchestrator/storage/node-sqlite-driver.js";

const PROJECT_ID = "1".repeat(64) as ProjectId;
const VAULT_ID = "2".repeat(64) as VaultId;
const STORE_ID = "3".repeat(64) as StoreId;
const WORKSPACE_ID = "4".repeat(64) as WorkspaceId;
const BRANCH_SCOPE_ID = "00000000-0000-4000-8000-000000000051" as BranchScopeId;
const NOW = "2026-08-25T03:00:00.000Z";
const FUNCTIONAL_TEST_DEADLINE_MS = 15_000;

const BINDING: ProjectBinding = Object.freeze({
  projectId: PROJECT_ID,
  vaultId: VAULT_ID,
  storeId: STORE_ID,
  workspaceId: WORKSPACE_ID,
  branchScopeId: BRANCH_SCOPE_ID,
  branchRef: "refs/heads/v2-reader-lease",
  sessionId: null,
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface PublishedV2Fixture {
  readonly source: DatabaseSync;
  readonly generation: LeasableV2ProjectionGeneration;
}

function sourceDatabase(path: string): DatabaseSync {
  const database = new DatabaseSync(path);
  database.exec(`
    PRAGMA application_id = ${PROJECT_MEMORY_APPLICATION_ID};
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE project_meta(
      singleton INTEGER PRIMARY KEY,
      project_id TEXT,
      vault_id TEXT,
      store_id TEXT
    ) STRICT;
    INSERT INTO project_meta VALUES (1, '${PROJECT_ID}', '${VAULT_ID}', '${STORE_ID}');
    CREATE TABLE events(
      global_position INTEGER PRIMARY KEY,
      event_id TEXT,
      project_id TEXT,
      vault_id TEXT,
      store_id TEXT,
      workspace_id TEXT,
      branch_scope_id TEXT,
      branch_ref TEXT,
      stream_id TEXT,
      stream_type TEXT,
      stream_version INTEGER,
      event_type TEXT,
      event_schema_version INTEGER,
      session_id TEXT,
      parent_session_id TEXT,
      actor_role TEXT,
      agent_id TEXT,
      client_instance_id TEXT,
      correlation_id TEXT,
      causation_id TEXT,
      command_id TEXT,
      idempotency_key TEXT,
      command_event_index INTEGER,
      occurred_at TEXT,
      recorded_at TEXT,
      visibility_scope TEXT,
      confidence TEXT,
      verification_status TEXT,
      source_refs_json TEXT,
      evidence_refs_json TEXT,
      evidence_digests_json TEXT,
      payload_json TEXT,
      payload_hash TEXT,
      previous_global_hash TEXT,
      event_hash TEXT,
      lifecycle_intent_json TEXT
    ) STRICT;
  `);
  return database;
}

function capturePublishedGeneration(
  published: PublishedProjectionGenerationV2,
): LeasableV2ProjectionGeneration {
  const lock = acquireProjectionManifestPublicationLease(published.projectionDirectory);
  try {
    const image = filesystemStableProjectionDirectoryOperations.readGenerationImage(
      published.projectionDirectory,
      lock.directoryIdentity,
      lock.lockToken,
      published.manifest.databaseFile,
    );
    return Object.freeze({ manifest: published.manifest, image });
  } finally {
    lock.release();
  }
}

async function publishedFixture(): Promise<PublishedV2Fixture> {
  const root = mkdtempSync(join(tmpdir(), "v2-reader-lease-"));
  roots.push(root);
  const sourcePath = join(root, "events.sqlite");
  const projectionDirectory = join(root, "projections");
  const source = sourceDatabase(sourcePath);
  const driver = new NodeSqliteDriver({ DatabaseSync });
  const coordinator = new V2ProjectionBuildCoordinator({
    projectionDirectory,
    eventReader: new SqliteProjectionEventReader({ driver, eventStorePath: sourcePath }),
    builder: new ImmutableProjectionBuilder({ driver, projectionDirectory, now: () => NOW }),
  });
  const published = await coordinator.ensurePublished(BINDING, 0n, FUNCTIONAL_TEST_DEADLINE_MS);
  return Object.freeze({ source, generation: capturePublishedGeneration(published) });
}

function assertIntegrityFailure(operation: () => void): void {
  assert.throws(operation, (error: unknown) => (
    error instanceof LifecycleError && error.code === "INTEGRITY_FAILURE"
  ));
}

function imageWith(
  image: StableProjectionGenerationImage,
  overrides: Readonly<Partial<StableProjectionGenerationImage>>,
): StableProjectionGenerationImage {
  return Object.freeze({ ...image, ...overrides });
}

function imageBytesWithMetadataCanary(image: StableProjectionGenerationImage): Uint8Array {
  const root = mkdtempSync(join(tmpdir(), "v2-reader-lease-canary-"));
  roots.push(root);
  const path = join(root, "substituted.sqlite");
  writeFileSync(path, image.bytes);
  const database = new DatabaseSync(path);
  try {
    database.prepare("UPDATE projection_metadata SET created_at = ?").run("substituted");
  } finally {
    database.close();
  }
  return Uint8Array.from(readFileSync(path));
}

function getterBackedGeneration(
  manifest: () => LeasableV2ProjectionGeneration["manifest"],
  image: () => StableProjectionGenerationImage,
): LeasableV2ProjectionGeneration {
  return Object.freeze(Object.defineProperties({}, {
    manifest: { enumerable: true, get: manifest },
    image: { enumerable: true, get: image },
  })) as LeasableV2ProjectionGeneration;
}

describe("V2 projection reader leases", () => {
  it("opens a verified published V2 image as a guarded in-memory reader lease", async () => {
    const fixture = await publishedFixture();
    try {
      const registry = new V2ProjectionReaderLeaseRegistry();
      const lease = registry.acquire(fixture.generation);
      try {
        assert.equal(
          Number(lease.database.prepare("SELECT schema_version FROM projection_metadata").get()?.schema_version),
          2,
        );
        assert.deepEqual(registry.activeFilenames(), [fixture.generation.manifest.databaseFile]);
        assert.equal(Object.isFrozen(registry.activeFilenames()), true);
        assert.equal(Number(lease.database.prepare("PRAGMA query_only").get()?.query_only), 1);
        assert.equal(Number(lease.database.prepare("PRAGMA trusted_schema").get()?.trusted_schema), 0);
        assert.equal(Number(lease.database.prepare("PRAGMA foreign_keys").get()?.foreign_keys), 1);
      } finally {
        lease.close();
      }
      assert.deepEqual(registry.activeFilenames(), []);
    } finally {
      fixture.source.close();
    }
  });

  it("rejects mismatched stable images and malformed captured bytes before retaining a filename", async () => {
    const fixture = await publishedFixture();
    try {
      const registry = new V2ProjectionReaderLeaseRegistry();
      const manifest = fixture.generation.manifest;
      const identityShaMismatch: LeasableV2ProjectionGeneration = Object.freeze({
        manifest,
        image: imageWith(fixture.generation.image, {
          identity: Object.freeze({ ...fixture.generation.image.identity, sha256: "f".repeat(64) }),
        }),
      });
      assertIntegrityFailure(() => registry.acquire(identityShaMismatch));
      assert.deepEqual(registry.activeFilenames(), []);

      const filenameMismatch: LeasableV2ProjectionGeneration = Object.freeze({
        manifest,
        image: imageWith(fixture.generation.image, {
          identity: Object.freeze({
            ...fixture.generation.image.identity,
            filename: "projections-2-999.sqlite",
          }),
        }),
      });
      assertIntegrityFailure(() => registry.acquire(filenameMismatch));
      assert.deepEqual(registry.activeFilenames(), []);

      const malformedBytes = Uint8Array.of(0, 1, 2, 3);
      const malformedSha256 = createHash("sha256").update(malformedBytes).digest("hex");
      const malformed: LeasableV2ProjectionGeneration = Object.freeze({
        manifest: Object.freeze({ ...manifest, databaseSha256: malformedSha256 }),
        image: imageWith(fixture.generation.image, {
          identity: Object.freeze({ ...fixture.generation.image.identity, sha256: malformedSha256 }),
          bytes: malformedBytes,
        }),
      });
      assertIntegrityFailure(() => registry.acquire(malformed));
      assert.deepEqual(registry.activeFilenames(), []);
    } finally {
      fixture.source.close();
    }
  });

  it("hashes and opens one copied captured image when its bytes getter changes", async () => {
    const fixture = await publishedFixture();
    try {
      const registry = new V2ProjectionReaderLeaseRegistry();
      const original = fixture.generation.image.bytes;
      const substituted = imageBytesWithMetadataCanary(fixture.generation.image);
      let reads = 0;
      const changingImage = Object.freeze(Object.defineProperties({}, {
        identity: { enumerable: true, get: () => fixture.generation.image.identity },
        bytes: {
          enumerable: true,
          get: () => {
            reads += 1;
            return reads === 1 ? original : substituted;
          },
        },
      })) as StableProjectionGenerationImage;
      const generation = getterBackedGeneration(
        () => fixture.generation.manifest,
        () => changingImage,
      );
      const lease = registry.acquire(generation);
      try {
        assert.equal(
          lease.database.prepare("SELECT created_at FROM projection_metadata").get()?.created_at,
          NOW,
        );
        assert.equal(reads, 1);
      } finally {
        lease.close();
      }
      assert.deepEqual(registry.activeFilenames(), []);
    } finally {
      fixture.source.close();
    }
  });

  it("uses a generation manifest snapshot before retaining its filename", async () => {
    const fixture = await publishedFixture();
    try {
      const registry = new V2ProjectionReaderLeaseRegistry();
      let manifestReads = 0;
      const generation = getterBackedGeneration(
        () => {
          manifestReads += 1;
          if (manifestReads !== 1) throw new Error("late manifest access");
          return fixture.generation.manifest;
        },
        () => fixture.generation.image,
      );
      const lease = registry.acquire(generation);
      try {
        assert.equal(manifestReads, 1);
        assert.equal(lease.manifest.databaseFile, fixture.generation.manifest.databaseFile);
      } finally {
        lease.close();
      }
      assert.deepEqual(registry.activeFilenames(), []);
    } finally {
      fixture.source.close();
    }
  });

  it("fails closed without retaining a filename when generation accessors throw", async () => {
    const fixture = await publishedFixture();
    try {
      const registry = new V2ProjectionReaderLeaseRegistry();
      const manifestGetterFailure = getterBackedGeneration(
        () => { throw new Error("manifest getter failure"); },
        () => fixture.generation.image,
      );
      assertIntegrityFailure(() => registry.acquire(manifestGetterFailure));
      assert.deepEqual(registry.activeFilenames(), []);

      const imageGetterFailure = getterBackedGeneration(
        () => fixture.generation.manifest,
        () => { throw new Error("image getter failure"); },
      );
      assertIntegrityFailure(() => registry.acquire(imageGetterFailure));
      assert.deepEqual(registry.activeFilenames(), []);
    } finally {
      fixture.source.close();
    }
  });

  it("retains one filename until every private V2 image lease closes exactly once", async () => {
    const fixture = await publishedFixture();
    try {
      const registry = new V2ProjectionReaderLeaseRegistry();
      const first = registry.acquire(fixture.generation);
      const second = registry.acquire(fixture.generation);
      try {
        assert.deepEqual(registry.activeFilenames(), [fixture.generation.manifest.databaseFile]);
        first.close();
        assert.throws(() => first.database.prepare("SELECT 1").get());
        assert.deepEqual(registry.activeFilenames(), [fixture.generation.manifest.databaseFile]);
        first.close();
        assert.deepEqual(registry.activeFilenames(), [fixture.generation.manifest.databaseFile]);
        second.close();
        assert.deepEqual(registry.activeFilenames(), []);
      } finally {
        first.close();
        second.close();
      }
    } finally {
      fixture.source.close();
    }
  });
});
