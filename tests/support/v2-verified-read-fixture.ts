import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ProjectionManifestV2 } from "../../src/orchestrator/projections/manifest.js";
import type { ProjectionDirectoryIdentity } from "../../src/orchestrator/projections/stable-directory.js";
import type { ReadFence, TrustedReadSession, VerifiedReadBinding, VerifiedReadRequest } from "../../src/orchestrator/verified-read/contracts.js";
import type { AppendCommand, JsonValue } from "../../src/orchestrator/contracts/event.js";
import type { BranchScopeId, ProjectContext } from "../../src/orchestrator/identity/contracts.js";
import { computeProjectContextFingerprint } from "../../src/orchestrator/identity/project-binding.service.js";
import type { SqliteConnection } from "../../src/orchestrator/storage/sqlite-driver.js";
import { NodeSqliteDriver } from "../../src/orchestrator/storage/node-sqlite-driver.js";
import { applyCurrentProjectStoreSchema } from "./current-project-store-schema.js";
import { freshGenesis, freshRelease, FRESH_IDENTITY, FRESH_NOW } from "./fresh-start-fixture.js";
import { expectedSchemaFingerprint } from "../../src/orchestrator/storage/schema-fingerprint.js";
import { PROJECT_STORE_MIGRATIONS } from "../../src/orchestrator/storage/migrations/registry.js";
import { SqliteFreshStartRepository } from "../../src/orchestrator/fresh-start/fresh-start.repository.js";
import { FreshStartControlPlane } from "../../src/orchestrator/fresh-start/fresh-start-control-plane.js";
import { TrustedFreshStartEvidenceVerifier, TrustedOperatorApprovalVerifier } from "../../src/orchestrator/fresh-start/operator-approval.js";
import { bindFreshStartAdmissionContext } from "../../src/orchestrator/fresh-start/fresh-start-admission.js";
import { EventStore, SqliteEventStoreStatements } from "../../src/orchestrator/storage/event-store.js";
import { MaintenanceFence } from "../../src/orchestrator/storage/maintenance-fence.js";
import { BranchScopeRepository } from "../../src/orchestrator/storage/branch-scope.repository.js";
import { command, context as fixtureProjectContext } from "../fixtures/fresh-start-admission-child.js";
import { ImmutableProjectionBuilder } from "../../src/orchestrator/projections/builder.js";
import { openCommittedProjectionEventSnapshot } from "../../src/orchestrator/projections/event-reader.js";
import { publishProjectionManifest } from "../../src/orchestrator/projections/manifest.js";

// Dynamic lookup lets the initial TDD run assert the absent implementation without a compiler error.
export type AdmissionConstructor = new (connection: SqliteConnection, binding: VerifiedReadBinding, measuredBuildHash: string) => {
  capture(request: VerifiedReadRequest): ReadFence;
  revalidate(fence: ReadFence, manifest: ProjectionManifestV2): void;
};
export async function readAdmissionConstructor(): Promise<AdmissionConstructor | undefined> {
  const modulePath = "../../src/orchestrator/verified-read/admission.js";
  try { return (await import(modulePath) as { SqliteVerifiedReadAdmission: AdmissionConstructor }).SqliteVerifiedReadAdmission; }
  catch (error) {
    if ((error as { code?: string }).code === "ERR_MODULE_NOT_FOUND") return undefined;
    throw error;
  }
}

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
  return { version: 3, ids: { requestId: "request", attemptId: "attempt", laneEpoch: "epoch" },
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

/** Real schema-8 authority exists only inside this owned synthetic fixture. */
export type ReadFixtureOptions = Readonly<{ branchScopeId?: string | null; branchRef?: string | null; session?: TrustedReadSession | null }>;
export async function makeActiveReadFixture(measuredBuildHash = READ_HASH, options: ReadFixtureOptions = {}) {
  const Admission = await readAdmissionConstructor();
  if (!Admission) throw new Error("Task 3 admission implementation is absent");
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "v2-active-read-")));
  const rootStat = lstatSync(root, { bigint: true });
  const directory = (name: string): ProjectionDirectoryIdentity => {
    const canonicalPath = join(root, name); mkdirSync(canonicalPath);
    const stat = lstatSync(canonicalPath, { bigint: true });
    return Object.freeze({ canonicalPath, device: String(stat.dev), inode: String(stat.ino) });
  };
  const path = join(root, "events.sqlite");
  const driver = new NodeSqliteDriver({ DatabaseSync });
  let writer: SqliteConnection | undefined;
  let reader: SqliteConnection | undefined;
  const cleanup = (): void => {
    let failure: unknown;
    const attempt = (operation: () => void) => { try { operation(); } catch (error) { failure ??= error; } };
    attempt(() => { const owned = reader; reader = undefined; owned?.close(); });
    attempt(() => { const owned = writer; writer = undefined; owned?.close(); });
    attempt(() => {
      const current = lstatSync(root, { bigint: true });
      if (!current.isDirectory() || current.isSymbolicLink() || realpathSync.native(root) !== root
        || current.dev !== rootStat.dev || current.ino !== rootStat.ino) throw new Error("owned fixture root changed");
      rmSync(root, { recursive: true, force: true });
    });
    if (failure !== undefined) throw failure;
  };
  try {
    const projectionDirectory = directory("projection");
    const executorStateDirectory = directory("executor-state");
    const deploymentDirectory = directory("deployment");
    const ownedWriter = driver.open(path, { mode: "create", busyTimeoutMs: 1000 });
    writer = ownedWriter;
    applyCurrentProjectStoreSchema(ownedWriter, FRESH_IDENTITY, FRESH_NOW);
    const release = freshRelease({ buildIdentityHash: measuredBuildHash,
      schemaIdentityHash: expectedSchemaFingerprint(PROJECT_STORE_MIGRATIONS) });
    const repository = new SqliteFreshStartRepository(ownedWriter);
    repository.transact(FRESH_IDENTITY, tx => tx.install(freshGenesis(), release));
    const approvals = new TrustedOperatorApprovalVerifier(async (_bytes, requestDigest) => ({ identity: FRESH_IDENTITY,
      approvalId: randomUUID(), nonceDigest: createHash("sha256").update(randomUUID()).digest("hex"),
      actorFingerprint: "2".repeat(64), requestDigest, evidenceDigest: release.evidenceDigest }));
    const control = new FreshStartControlPlane(repository, approvals, new TrustedFreshStartEvidenceVerifier(async value => value));
    await control.transition({ identity: FRESH_IDENTITY, expectedGeneration: 0n, expectedMode: "prepared",
      expectedReleaseId: release.releaseId, nextMode: "active", nextRelease: release, approvalEnvelope: new Uint8Array([1]) });
    bindFreshStartAdmissionContext(ownedWriter, { identity: FRESH_IDENTITY, releaseId: release.releaseId, measuredBuildHash, generation: 1n });
    const projectContext: ProjectContext = fixtureProjectContext(root, path);
    const branchScopes = new BranchScopeRepository({ randomId: () => options.branchScopeId as BranchScopeId });
    if (options.branchScopeId != null || options.branchRef != null) {
      if (options.branchScopeId == null) throw new Error("synthetic branch scope required");
      const workspace = { kind: "git" as const, worktreeRoot: root, gitDir: join(root, ".git"),
        gitCommonDir: join(root, ".git"), headCommit: "a".repeat(40), branchRef: options.branchRef ?? null,
        detached: options.branchRef == null, workspaceId: projectContext.workspace.workspaceId };
      projectContext.workspace = workspace;
      projectContext.binding.workspace = workspace;
      projectContext.branchScopeId = branchScopes.resolveOrCreate(ownedWriter, FRESH_IDENTITY.projectId, workspace, FRESH_NOW);
      projectContext.binding.contextFingerprint = computeProjectContextFingerprint(projectContext.binding);
    }
    const stat = lstatSync(path, { bigint: true });
    const binding: VerifiedReadBinding = Object.freeze({ projectionBinding: Object.freeze({ ...FRESH_IDENTITY,
      workspaceId: projectContext.binding.workspaceId, branchScopeId: projectContext.branchScopeId ?? null,
      branchRef: projectContext.workspace.kind === "git" ? projectContext.workspace.branchRef : null, sessionId: null }),
      expectedRelease: release, controlGeneration: "1", session: options.session ?? null,
      eventsFile: Object.freeze({ path, device: String(stat.dev), inode: String(stat.ino) }),
      projectionDirectory, executorStateDirectory, deploymentDirectory, compositionEpoch: "fixture-epoch" });
    reader = driver.open(path, { mode: "read-only-existing", bindFileIdentity: true, busyTimeoutMs: 1000 });
    const admission = new Admission(reader, binding, measuredBuildHash);
    const request: VerifiedReadRequest = Object.freeze({ operation: "verify-published-view", consistency: "project-strong", minimumEventPosition: "0", budgetMs: 5000 });
    const store = new EventStore(ownedWriter, new SqliteEventStoreStatements(ownedWriter), new MaintenanceFence(), branchScopes, () => FRESH_NOW);
    const appendSynthetic = (value: AppendCommand<JsonValue>) => {
      const result = store.append({ ...value, context: projectContext });
      return Object.freeze({ position: result.lastGlobalPosition.toString(), hash: ownedWriter.prepare("SELECT event_hash FROM events WHERE global_position = $position")
        .get({ $position: result.lastGlobalPosition })!.event_hash as string });
    };
    let appendNumber = 0;
    const append = () => {
      const value = command(); appendNumber += 1;
      return appendSynthetic({ ...value, commandId: randomUUID(), correlationId: randomUUID(), idempotencyKey: `read:${appendNumber}`,
        streamId: `read-stream-${appendNumber}` });
    };
    let generation = 0;
    const publish = async () => {
      const snapshot = openCommittedProjectionEventSnapshot(binding.projectionBinding, { driver, eventStorePath: path, busyTimeoutMs: 1000 });
      try {
        const staged = await new ImmutableProjectionBuilder({ driver, projectionDirectory: projectionDirectory.canonicalPath, now: () => FRESH_NOW })
          .buildV2(snapshot, ++generation);
        publishProjectionManifest({ projectionDirectory: projectionDirectory.canonicalPath, manifest: staged.manifest,
          expectedBinding: binding.projectionBinding }, { beforeManifestInstall: { install(directory) {
            renameSync(staged.temporaryDatabasePath, join(directory, staged.manifest.databaseFile));
          } } });
        return staged.manifest;
      } finally { snapshot.close(); }
    };
    const manifest = await publish();
    return { root, path, reader, writer: ownedWriter, binding, measuredBuildHash, identity: FRESH_IDENTITY, release,
      repository, control, admission, request, manifest, projectContext, append, appendSynthetic, publish, cleanup };
  } catch (error) { try { cleanup(); } catch { /* preserve setup failure */ } throw error; }
}
