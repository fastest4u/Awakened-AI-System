import { DatabaseSync } from "node:sqlite";
import { FreshStartInitializer } from "../orchestrator/fresh-start/fresh-start-initializer.js";
import { assertFreshStartPaths, assertFreshStartOwnedDirectory } from "../orchestrator/fresh-start/fresh-start-paths.js";
import { FreshStartError, type FreshStartIdentity, type FreshStartMode, type FreshStartRelease } from "../orchestrator/fresh-start/contracts.js";
import { SqliteFreshStartRepository } from "../orchestrator/fresh-start/fresh-start.repository.js";
import { DENY_FRESH_START_PROMOTION } from "../orchestrator/fresh-start/operator-approval.js";
import { ProjectDescriptorRepository } from "../orchestrator/identity/project-descriptor.repository.js";
import { GitWorkspaceResolver, SpawnSyncGitCommandRunner } from "../orchestrator/identity/git-workspace.resolver.js";
import { ProjectStoreRouter } from "../orchestrator/identity/project-store.router.js";
import { NodeSqliteDriver } from "../orchestrator/storage/node-sqlite-driver.js";
import { CURRENT_PROJECT_STORE_SCHEMA_VERSION, PROJECT_STORE_MIGRATIONS } from "../orchestrator/storage/migrations/registry.js";
import { expectedSchemaFingerprint } from "../orchestrator/storage/schema-fingerprint.js";
import { inspectV2Build } from "./build-identity.js";
import { configurationDigest, loadV2LaunchConfig, V2_CAPABILITIES, V2_RECOVERY_POLICY, type V2LaunchConfig } from "./config.js";

export type FreshStartStatus = FreshStartIdentity & Readonly<{
  profile: "fresh-start"; profileVersion: 1; releaseId: string; mode: FreshStartMode; generation: string;
  schemaVersion: number; schemaIdentityHash: string; buildIdentityHash: string; productionReady: false;
}>;
/** Future content adapters must enter through this typed composition boundary. */
export interface V2ContentAdapters { invoke(name: string, argumentsValue: unknown): Promise<never>; }
export interface V2Foundation { status(): Promise<FreshStartStatus>; close(): Promise<void>; readonly content: V2ContentAdapters; }

export function assertPreparedRelease(release: Omit<FreshStartRelease, keyof FreshStartIdentity>, config: V2LaunchConfig, build: string): void {
  if (release.releaseId !== config.releaseId || release.buildIdentityHash !== build
    || release.schemaIdentityHash !== expectedSchemaFingerprint(PROJECT_STORE_MIGRATIONS)
    || release.configurationHash !== configurationDigest(config)
    || release.capabilityManifestHash !== configurationDigest(V2_CAPABILITIES)
    || release.recoveryPolicyHash !== configurationDigest(V2_RECOVERY_POLICY)) throw new FreshStartError("FRESH_START_RELEASE_MISMATCH");
}

export async function createV2Foundation(input: V2LaunchConfig): Promise<V2Foundation> {
  // Revalidate even trusted callers so no alternate startup path gains defaults.
  const explicit = loadV2LaunchConfig({ MEMORY_PROJECT_ROOT: input.projectRoot, MEMORY_V2_VAULT_PATH: input.v2VaultRoot,
    MEMORY_V1_ARCHIVE_PATH: input.v1ArchiveRoot, MEMORY_V2_RELEASE_ID: input.releaseId });
  const paths = await assertFreshStartPaths(explicit);
  const config = Object.freeze({ ...paths, releaseId: explicit.releaseId });
  const measuredBuild = inspectV2Build();
  const receipt = await new FreshStartInitializer().openExisting(paths);
  const descriptor = new ProjectDescriptorRepository().inspect(paths.v2VaultRoot);
  if (descriptor.status !== "valid") throw new FreshStartError("FRESH_START_RECOVERY_REQUIRED");
  const workspace = new GitWorkspaceResolver(new SpawnSyncGitCommandRunner()).inspect(paths.projectRoot, descriptor.descriptor);
  const route = new ProjectStoreRouter().route(descriptor.descriptor, paths.v2VaultRoot, workspace);
  assertFreshStartOwnedDirectory(route.storeRoot, paths.v1ArchiveRoot);
  const connection = new NodeSqliteDriver({ DatabaseSync }).open(route.eventsPath, { mode: "existing", busyTimeoutMs: 5000, bindFileIdentity: true });
  const repository = new SqliteFreshStartRepository(connection);
  const identity = { projectId: receipt.projectId, vaultId: receipt.vaultId, storeId: receipt.storeId };
  let closed = false;
  const foundation: V2Foundation = Object.freeze({
    async status(): Promise<FreshStartStatus> {
      if (closed) throw new FreshStartError("FRESH_START_STORAGE_FAILURE");
      if (inspectV2Build() !== measuredBuild) throw new FreshStartError("FRESH_START_BUILD_MISMATCH");
      return repository.transact(identity, tx => {
        const state = tx.state();
        if (!state) throw new FreshStartError("FRESH_START_RECOVERY_REQUIRED");
        const release = tx.release(state.releaseId);
        if (!release) throw new FreshStartError("FRESH_START_RELEASE_MISMATCH");
        assertPreparedRelease(release, config, measuredBuild);
        return Object.freeze({ profile: "fresh-start", profileVersion: 1, ...identity, releaseId: state.releaseId,
          mode: state.mode, generation: state.generation.toString(), schemaVersion: CURRENT_PROJECT_STORE_SCHEMA_VERSION,
          schemaIdentityHash: release.schemaIdentityHash, buildIdentityHash: measuredBuild, productionReady: false });
      });
    },
    content: Object.freeze({ async invoke(): Promise<never> {
      await DENY_FRESH_START_PROMOTION.verify(new Uint8Array(), "");
      throw new FreshStartError("FRESH_START_RELEASE_NOT_READY");
    } }),
    async close(): Promise<void> { if (!closed) { connection.close(); closed = true; } },
  });
  try { await foundation.status(); return foundation; }
  catch (primary) {
    try { await foundation.close(); } catch { /* Startup already fails; retain its primary diagnostic. */ }
    throw primary;
  }
}
