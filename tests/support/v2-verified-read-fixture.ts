import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ProjectionManifestV2 } from "../../src/orchestrator/projections/manifest.js";
import type { ProjectionDirectoryIdentity } from "../../src/orchestrator/projections/stable-directory.js";

export const READ_UUID = "11111111-1111-4111-8111-111111111111";
export const READ_HASH = "a".repeat(64);
export function readScope() {
  return { projectId: READ_UUID, vaultId: READ_UUID, storeId: READ_UUID, workspaceId: READ_HASH,
    branchScopeId: null, branchRef: null, sessionId: null };
}
export function readRequest() {
  return { operation: "verify-published-view", consistency: "project-strong", minimumEventPosition: "0", budgetMs: 5000 };
}
export function readReceipt() {
  return { operation: "verify-published-view", consistency: "project-strong", scope: readScope(),
    releaseId: READ_UUID, controlGeneration: "0", requiredEventPosition: "0", projectionGeneration: 1,
    projectionEventPosition: "0", projectionEventHash: READ_HASH, imageSha256: READ_HASH,
    verification: "image-scope-position-and-active-admission" };
}
export function readBootstrap() {
  const directory = () => ({ canonicalPath: "C:/owned", device: "1", inode: "2" });
  return { version: 1, ids: { requestId: "request", attemptId: "attempt", laneEpoch: "epoch" },
    binding: { projectionBinding: readScope(), expectedRelease: { projectId: READ_UUID, vaultId: READ_UUID,
      storeId: READ_UUID, profileVersion: 1, releaseId: READ_UUID, buildIdentityHash: READ_HASH,
      schemaIdentityHash: READ_HASH, configurationHash: READ_HASH, capabilityManifestHash: READ_HASH,
      recoveryPolicyHash: READ_HASH, evidenceDigest: READ_HASH, createdAt: "2026-10-01T00:00:00.000Z" },
      controlGeneration: "0", session: null, eventsFile: { path: "C:/owned/events.sqlite", device: "1", inode: "2" },
      projectionDirectory: directory(), executorStateDirectory: directory(), deploymentDirectory: directory(), compositionEpoch: "epoch" },
    request: readRequest(), lockToken: "a".repeat(32), remainingMs: 5000 };
}

/** Owned filesystem and detached image fixtures; no active-store authority. */
export function ownedReadDirectory(): ProjectionDirectoryIdentity {
  const canonicalPath = realpathSync.native(mkdtempSync(join(tmpdir(), "v2-read-core-")));
  const stat = lstatSync(canonicalPath, { bigint: true });
  return Object.freeze({ canonicalPath, device: String(stat.dev), inode: String(stat.ino) });
}

export function ownedReadImage(updateSql = ""): Readonly<{ bytes: Uint8Array; manifest: ProjectionManifestV2 }> {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`
      CREATE VIRTUAL TABLE lexical_chunks_fts USING fts5(content);
      CREATE TABLE projection_metadata(singleton, schema_version, project_id, vault_id, store_id,
        workspace_id, branch_scope_id, branch_ref, session_id, generation, terminal_event_position, terminal_event_hash);
    `);
    const scope = readScope();
    database.prepare("INSERT INTO projection_metadata VALUES(1, 2, ?, ?, ?, ?, NULL, NULL, NULL, 1, 9223372036854775807, ?)")
      .run(scope.projectId, scope.vaultId, scope.storeId, scope.workspaceId, READ_HASH);
    database.exec(updateSql);
    const bytes = Uint8Array.from((database as DatabaseSync & { serialize(): Uint8Array }).serialize());
    const manifest = Object.freeze({ schemaVersion: 2, ...scope, generation: 1, highestObservedGeneration: 1,
      terminalEventPosition: "9223372036854775807", terminalEventHash: READ_HASH,
      databaseFile: "projections-2-1.sqlite", databaseSha256: createHash("sha256").update(bytes).digest("hex"),
      coreChecksums: Object.freeze({ sessionTree: READ_HASH, sessionCheckpoints: READ_HASH,
        canonicalItems: READ_HASH, tasksFollowups: READ_HASH, artifactsFiles: READ_HASH,
        entityGraph: READ_HASH, lexicalChunks: READ_HASH, retrievalFeedback: READ_HASH }),
      createdAt: "2026-10-01T00:00:00.000Z" }) as ProjectionManifestV2;
    return Object.freeze({ bytes, manifest });
  } finally { database.close(); }
}
