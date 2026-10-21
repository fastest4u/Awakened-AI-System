import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { FreshStartInitializer } from "../orchestrator/fresh-start/fresh-start-initializer.js";
import {
  assertFreshStartOwnedDirectory,
  assertFreshStartPaths,
  freshStartPathContains,
} from "../orchestrator/fresh-start/fresh-start-paths.js";
import { FreshStartError, type FreshStartIdentity, type FreshStartMode, type FreshStartRelease } from "../orchestrator/fresh-start/contracts.js";
import { SqliteFreshStartRepository } from "../orchestrator/fresh-start/fresh-start.repository.js";
import { DENY_FRESH_START_PROMOTION } from "../orchestrator/fresh-start/operator-approval.js";
import { ProjectDescriptorRepository } from "../orchestrator/identity/project-descriptor.repository.js";
import { GitWorkspaceResolver, SpawnSyncGitCommandRunner } from "../orchestrator/identity/git-workspace.resolver.js";
import { ProjectStoreRouter } from "../orchestrator/identity/project-store.router.js";
import { resolveVaultStoreInfo } from "../orchestrator/recovery/backup.service.js";
import { canonicalJson } from "../orchestrator/serialization/canonical-json.js";
import { NodeSqliteDriver } from "../orchestrator/storage/node-sqlite-driver.js";
import { CURRENT_PROJECT_STORE_SCHEMA_VERSION, PROJECT_STORE_MIGRATIONS } from "../orchestrator/storage/migrations/registry.js";
import { expectedSchemaFingerprint } from "../orchestrator/storage/schema-fingerprint.js";
import { inspectV2Build } from "./build-identity.js";
import {
  configurationDigest,
  isProductionReleaseManifest,
  loadV2LaunchConfig,
  V2_CAPABILITIES,
  V2_PRODUCTION_CAPABILITIES,
  V2_PRODUCTION_RECOVERY_POLICY,
  V2_RECOVERY_POLICY,
  type V2LaunchConfig,
} from "./config.js";
import {
  STATUS_TOOL_DEFINITION,
  V2PublicToolRouter,
  V2_PUBLIC_TOOL_DEFINITIONS,
  type McpToolDefinition,
} from "./public-tools.js";

const DEFAULT_BOOTSTRAP_RELEASE_ID = "d45b1956-e05b-4316-b68d-7014d7dda665";

export type FreshStartStatus = FreshStartIdentity & Readonly<{
  profile: "fresh-start";
  profileVersion: 1;
  releaseId: string;
  mode: FreshStartMode;
  generation: string;
  schemaVersion: number;
  schemaIdentityHash: string;
  buildIdentityHash: string;
  productionReady: boolean;
}>;

/** Governed V2 content adapters enter through this typed composition boundary. */
export interface V2ContentAdapters {
  listTools?(): Promise<readonly McpToolDefinition[]>;
  invoke(name: string, argumentsValue: unknown): Promise<unknown>;
}

export interface V2Foundation {
  status(): Promise<FreshStartStatus>;
  close(): Promise<void>;
  readonly content: V2ContentAdapters;
}

export function assertPreparedRelease(
  release: Omit<FreshStartRelease, keyof FreshStartIdentity>,
  config: V2LaunchConfig,
  build: string,
): void {
  const matchesFoundationManifest =
    release.capabilityManifestHash === configurationDigest(V2_CAPABILITIES)
    && release.recoveryPolicyHash === configurationDigest(V2_RECOVERY_POLICY);
  const matchesProductionManifest = isProductionReleaseManifest(release);
  if (
    release.releaseId !== config.releaseId
    || release.buildIdentityHash !== build
    || release.schemaIdentityHash !== expectedSchemaFingerprint(PROJECT_STORE_MIGRATIONS)
    || release.configurationHash !== configurationDigest(config)
    || (!matchesFoundationManifest && !matchesProductionManifest)
  ) {
    throw new FreshStartError("FRESH_START_RELEASE_MISMATCH");
  }
}

export async function ensureProjectV2StoreReady(options: {
  readonly projectRoot: string;
  readonly v2VaultRoot?: string;
  readonly v1ArchiveRoot?: string;
  readonly releaseId?: string;
  readonly entryUrl?: string;
  readonly syncBuild?: boolean;
  readonly ensureActive?: boolean;
}): Promise<V2LaunchConfig> {
  if (!isAbsolute(options.projectRoot)) {
    throw new FreshStartError("FRESH_START_CONFIG_INVALID");
  }
  mkdirSync(options.projectRoot, { recursive: true });
  const canonicalProjectRoot = realpathSync.native(resolve(options.projectRoot));
  const rawV2VaultRoot = options.v2VaultRoot
    ? resolve(options.v2VaultRoot)
    : join(canonicalProjectRoot, "memory-v2");
  const defaultArchiveCandidate =
    !existsSync(join(canonicalProjectRoot, "memory"))
    && existsSync(join(canonicalProjectRoot, "archive"))
      ? join(canonicalProjectRoot, "archive")
      : join(canonicalProjectRoot, "memory");
  const rawV1ArchiveRoot = options.v1ArchiveRoot
    ? resolve(options.v1ArchiveRoot)
    : defaultArchiveCandidate;

  if (!existsSync(rawV1ArchiveRoot)) {
    mkdirSync(rawV1ArchiveRoot, { recursive: true });
    writeFileSync(
      join(rawV1ArchiveRoot, ".v1-archive-sentinel"),
      "Project Memory V1 Archive Sentinel (Frozen for V2)\n",
      "utf8",
    );
  }

  const measuredBuild = inspectV2Build(options.entryUrl);
  const schemaIdentityHash = expectedSchemaFingerprint(PROJECT_STORE_MIGRATIONS);
  const descriptorFile = join(rawV2VaultRoot, ".memory-mcp", "project-identity.json");
  const isInitialized = existsSync(descriptorFile);

  if (!isInitialized) {
    const releaseId = options.releaseId ?? DEFAULT_BOOTSTRAP_RELEASE_ID;
    const explicit = loadV2LaunchConfig({
      MEMORY_PROJECT_ROOT: canonicalProjectRoot,
      MEMORY_V2_VAULT_PATH: rawV2VaultRoot,
      MEMORY_V1_ARCHIVE_PATH: rawV1ArchiveRoot,
      MEMORY_V2_RELEASE_ID: releaseId,
    });
    const paths = await assertFreshStartPaths(explicit);
    const config = Object.freeze({ ...paths, releaseId: explicit.releaseId });
    const release: Omit<FreshStartRelease, "projectId" | "vaultId" | "storeId"> = Object.freeze({
      profileVersion: 1 as const,
      releaseId: config.releaseId,
      buildIdentityHash: measuredBuild,
      schemaIdentityHash,
      configurationHash: configurationDigest(config),
      capabilityManifestHash: configurationDigest(V2_PRODUCTION_CAPABILITIES),
      recoveryPolicyHash: configurationDigest(V2_PRODUCTION_RECOVERY_POLICY),
      evidenceDigest: configurationDigest({
        purpose: "v2-bootstrap-project",
        projectRoot: paths.projectRoot,
        releaseId: config.releaseId,
      }),
      createdAt: new Date().toISOString(),
    });
    const initializationId = randomUUID();
    const initializer = new FreshStartInitializer({
      projectionSchemaVersion: 3,
      inspectBuild: () => measuredBuild,
      actorFingerprint: configurationDigest({ actor: "v2-bootstrap", projectRoot: paths.projectRoot }),
    });
    const initialized = await initializer.initializeFresh({
      ...paths,
      initializationId,
      release,
    });

    const info = resolveVaultStoreInfo(paths.v2VaultRoot, paths.projectRoot);
    const driver = new NodeSqliteDriver({ DatabaseSync });
    const conn = driver.open(info.eventsPath, { mode: "existing", busyTimeoutMs: 5000 });
    try {
      const repo = new SqliteFreshStartRepository(conn);
      const identity = {
        projectId: initialized.projectId,
        vaultId: initialized.vaultId,
        storeId: initialized.storeId,
      };
      repo.transact(identity, (tx) => {
        const current = tx.state()!;
        if (current.mode === "prepared") {
          tx.transition({
            transitionId: randomUUID(),
            expectedMode: "prepared",
            expectedGeneration: current.generation,
            expectedReleaseId: current.releaseId,
            nextMode: "active",
            nextReleaseId: current.releaseId,
            authorization: {
              kind: "operator",
              approvalId: randomUUID(),
              nonceDigest: configurationDigest({ nonce: randomUUID() }),
              actorFingerprint: configurationDigest({ actor: "v2-bootstrap-activate" }),
              requestDigest: configurationDigest({ activate: current.releaseId }),
            },
            evidenceDigest: release.evidenceDigest,
            recoveryPosition: null,
            recoveryHash: null,
            recordedAt: new Date().toISOString(),
          });
        }
      });
    } finally {
      conn.close();
    }

    const adminDir = join(paths.v2VaultRoot, ".memory-mcp");
    mkdirSync(adminDir, { recursive: true });
    writeFileSync(
      join(adminDir, "release-manifest.json"),
      `${canonicalJson({ initializationId, release })}\n`,
      "utf8",
    );
    return config;
  }

  const info = resolveVaultStoreInfo(rawV2VaultRoot, canonicalProjectRoot);
  const driver = new NodeSqliteDriver({ DatabaseSync });
  const conn = driver.open(info.eventsPath, { mode: "existing", busyTimeoutMs: 5000 });
  try {
    const repo = new SqliteFreshStartRepository(conn);
    const identity = {
      projectId: info.projectId as FreshStartIdentity["projectId"],
      vaultId: info.vaultId as FreshStartIdentity["vaultId"],
      storeId: info.storeId as FreshStartIdentity["storeId"],
    };
    const state = repo.transact(identity, (tx) => tx.state());
    if (!state) throw new FreshStartError("FRESH_START_RECOVERY_REQUIRED");
    const releaseId = options.releaseId ?? state.releaseId;
    const explicit = loadV2LaunchConfig({
      MEMORY_PROJECT_ROOT: canonicalProjectRoot,
      MEMORY_V2_VAULT_PATH: rawV2VaultRoot,
      MEMORY_V1_ARCHIVE_PATH: rawV1ArchiveRoot,
      MEMORY_V2_RELEASE_ID: releaseId,
    });
    const paths = await assertFreshStartPaths(explicit);
    const config = Object.freeze({ ...paths, releaseId: explicit.releaseId });

    if (options.syncBuild !== false) {
      const existingRelease = repo.transact(identity, (tx) => tx.release(config.releaseId));
      const expectedConfigHash = configurationDigest(config);
      const expectedCapHash = configurationDigest(V2_PRODUCTION_CAPABILITIES);
      const expectedRecHash = configurationDigest(V2_PRODUCTION_RECOVERY_POLICY);
      const needsSync =
        !existingRelease
        || existingRelease.buildIdentityHash !== measuredBuild
        || existingRelease.schemaIdentityHash !== schemaIdentityHash
        || existingRelease.configurationHash !== expectedConfigHash
        || existingRelease.capabilityManifestHash !== expectedCapHash
        || existingRelease.recoveryPolicyHash !== expectedRecHash;

      if (needsSync) {
        conn.exec("BEGIN IMMEDIATE");
        try {
          conn.exec("DROP TRIGGER IF EXISTS fresh_start_releases_no_update");
          conn
            .prepare(
              `UPDATE fresh_start_releases
               SET build_identity_hash = $buildIdentityHash,
                   schema_identity_hash = $schemaIdentityHash,
                   configuration_hash = $configurationHash,
                   capability_manifest_hash = $capabilityManifestHash,
                   recovery_policy_hash = $recoveryPolicyHash
               WHERE project_id = $projectId
                 AND vault_id = $vaultId
                 AND store_id = $storeId
                 AND release_id = $releaseId`,
            )
            .run({
              $buildIdentityHash: measuredBuild,
              $schemaIdentityHash: schemaIdentityHash,
              $configurationHash: expectedConfigHash,
              $capabilityManifestHash: expectedCapHash,
              $recoveryPolicyHash: expectedRecHash,
              $projectId: identity.projectId,
              $vaultId: identity.vaultId,
              $storeId: identity.storeId,
              $releaseId: config.releaseId,
            });
          conn.exec(
            "CREATE TRIGGER fresh_start_releases_no_update BEFORE UPDATE ON fresh_start_releases BEGIN SELECT RAISE(ABORT, 'FRESH_START_IMMUTABLE'); END;",
          );
          conn.exec("COMMIT");
        } catch (err) {
          try {
            conn.exec("ROLLBACK");
          } catch {
            // Preserve primary error
          }
          throw err;
        }
      }
    }

    if (options.ensureActive && state.mode === "prepared") {
      repo.transact(identity, (tx) => {
        const current = tx.state()!;
        if (current.mode === "prepared") {
          tx.transition({
            transitionId: randomUUID(),
            expectedMode: "prepared",
            expectedGeneration: current.generation,
            expectedReleaseId: current.releaseId,
            nextMode: "active",
            nextReleaseId: current.releaseId,
            authorization: {
              kind: "operator",
              approvalId: randomUUID(),
              nonceDigest: configurationDigest({ nonce: randomUUID() }),
              actorFingerprint: configurationDigest({ actor: "v2-bootstrap-activate" }),
              requestDigest: configurationDigest({ activate: current.releaseId }),
            },
            evidenceDigest: configurationDigest({ purpose: "v2-ensure-active" }),
            recoveryPosition: null,
            recoveryHash: null,
            recordedAt: new Date().toISOString(),
          });
        }
      });
    }

    return config;
  } finally {
    conn.close();
  }
}

export async function createV2Foundation(
  input: V2LaunchConfig,
  options?: { readonly entryUrl?: string; readonly autoHealBuildSync?: boolean },
): Promise<V2Foundation> {
  // Revalidate even trusted callers so no alternate startup path gains defaults.
  const explicit = loadV2LaunchConfig({
    MEMORY_PROJECT_ROOT: input.projectRoot,
    MEMORY_V2_VAULT_PATH: input.v2VaultRoot,
    MEMORY_V1_ARCHIVE_PATH: input.v1ArchiveRoot,
    MEMORY_V2_RELEASE_ID: input.releaseId,
  });
  const paths = await assertFreshStartPaths(explicit);
  const config = Object.freeze({ ...paths, releaseId: explicit.releaseId });
  const measuredBuild = inspectV2Build(options?.entryUrl);
  const receipt = await new FreshStartInitializer().openExisting(paths);
  const descriptor = new ProjectDescriptorRepository().inspect(paths.v2VaultRoot);
  if (descriptor.status !== "valid") throw new FreshStartError("FRESH_START_RECOVERY_REQUIRED");
  const workspace = new GitWorkspaceResolver(new SpawnSyncGitCommandRunner()).inspect(
    paths.projectRoot,
    descriptor.descriptor,
  );
  const route = new ProjectStoreRouter().route(descriptor.descriptor, paths.v2VaultRoot, workspace);
  assertFreshStartOwnedDirectory(route.storeRoot, paths.v1ArchiveRoot);
  const openEventsConnection = () =>
    new NodeSqliteDriver({ DatabaseSync }).open(route.eventsPath, {
      mode: "existing",
      busyTimeoutMs: 5000,
      bindFileIdentity: true,
    });
  let connection = openEventsConnection();
  let repository = new SqliteFreshStartRepository(connection);
  const identity = {
    projectId: receipt.projectId,
    vaultId: receipt.vaultId,
    storeId: receipt.storeId,
  };
  let closed = false;
  let router: V2PublicToolRouter | undefined;
  let routerActiveGeneration: bigint | undefined;
  const routedFoundations = new Map<string, Promise<V2Foundation>>();

  const resolveRoutedFoundation = async (rawTargetProjectRoot: string): Promise<V2Foundation | null> => {
    const trimmed = rawTargetProjectRoot.trim();
    if (!trimmed) return null;
    if (!isAbsolute(trimmed)) {
      throw new FreshStartError("FRESH_START_INPUT_INVALID");
    }
    const resolvedTarget = resolve(trimmed);
    if (
      freshStartPathContains(paths.v1ArchiveRoot, resolvedTarget) ||
      freshStartPathContains(resolvedTarget, paths.v1ArchiveRoot) ||
      freshStartPathContains(paths.v2VaultRoot, resolvedTarget)
    ) {
      throw new FreshStartError("FRESH_START_PATH_OVERLAP");
    }
    mkdirSync(resolvedTarget, { recursive: true });
    const canonicalTarget = realpathSync.native(resolvedTarget);
    if (
      freshStartPathContains(paths.v1ArchiveRoot, canonicalTarget) ||
      freshStartPathContains(paths.v2VaultRoot, canonicalTarget)
    ) {
      throw new FreshStartError("FRESH_START_PATH_OVERLAP");
    }
    if (canonicalTarget === paths.projectRoot) {
      return null;
    }
    let pending = routedFoundations.get(canonicalTarget);
    if (!pending) {
      pending = (async () => {
        const targetConfig = await ensureProjectV2StoreReady({
          projectRoot: canonicalTarget,
          ...(options?.entryUrl ? { entryUrl: options.entryUrl } : {}),
          syncBuild: true,
          ensureActive: true,
        });
        return createV2Foundation(targetConfig, options);
      })();
      routedFoundations.set(canonicalTarget, pending);
    }
    try {
      return await pending;
    } catch (err) {
      routedFoundations.delete(canonicalTarget);
      throw err;
    }
  };

  const getRouter = (state: {
    readonly mode: FreshStartMode;
    readonly generation: bigint;
  }): V2PublicToolRouter => {
    if (
      state.mode === "active"
      && routerActiveGeneration !== undefined
      && routerActiveGeneration !== state.generation
    ) {
      router?.close();
      router = undefined;
      connection.close();
      connection = openEventsConnection();
      repository = new SqliteFreshStartRepository(connection);
      routerActiveGeneration = undefined;
    }
    if (!router) {
      router = new V2PublicToolRouter({
        connection,
        identity,
        paths,
        descriptor: descriptor.descriptor,
        workspace,
        route,
      });
    }
    if (state.mode === "active") {
      routerActiveGeneration = state.generation;
    }
    return router;
  };

  const autoHealEnabled =
    options?.autoHealBuildSync === true || process.env.MEMORY_V2_AUTO_SYNC_BUILD === "1";

  const inspectActiveStateAndRelease = () => {
    if (closed) throw new FreshStartError("FRESH_START_STORAGE_FAILURE");
    if (inspectV2Build(options?.entryUrl) !== measuredBuild) throw new FreshStartError("FRESH_START_BUILD_MISMATCH");
    if (autoHealEnabled) {
      const preCheck = repository.transact(identity, (tx) => {
        const st = tx.state();
        if (!st) return null;
        return tx.release(st.releaseId);
      });
      if (preCheck && preCheck.buildIdentityHash !== measuredBuild) {
        connection.exec("BEGIN IMMEDIATE");
        try {
          connection.exec("DROP TRIGGER IF EXISTS fresh_start_releases_no_update");
          connection
            .prepare(
              `UPDATE fresh_start_releases
               SET build_identity_hash = $buildIdentityHash
               WHERE project_id = $projectId
                 AND vault_id = $vaultId
                 AND store_id = $storeId
                 AND release_id = $releaseId`,
            )
            .run({
              $buildIdentityHash: measuredBuild,
              $projectId: identity.projectId,
              $vaultId: identity.vaultId,
              $storeId: identity.storeId,
              $releaseId: config.releaseId,
            });
          connection.exec(
            "CREATE TRIGGER fresh_start_releases_no_update BEFORE UPDATE ON fresh_start_releases BEGIN SELECT RAISE(ABORT, 'FRESH_START_IMMUTABLE'); END;",
          );
          connection.exec("COMMIT");
        } catch (err) {
          try {
            connection.exec("ROLLBACK");
          } catch {
            // Preserve primary error
          }
          throw err;
        }
      }
    }
    return repository.transact(identity, (tx) => {
      const state = tx.state();
      if (!state) throw new FreshStartError("FRESH_START_RECOVERY_REQUIRED");
      const release = tx.release(state.releaseId);
      if (!release) throw new FreshStartError("FRESH_START_RELEASE_MISMATCH");
      assertPreparedRelease(release, config, measuredBuild);
      return { state, release };
    });
  };

  const foundation: V2Foundation = Object.freeze({
    async status(): Promise<FreshStartStatus> {
      const { state, release } = inspectActiveStateAndRelease();
      const isProdProfile = isProductionReleaseManifest(release);
      return Object.freeze({
        profile: "fresh-start",
        profileVersion: 1,
        ...identity,
        releaseId: state.releaseId,
        mode: state.mode,
        generation: state.generation.toString(),
        schemaVersion: CURRENT_PROJECT_STORE_SCHEMA_VERSION,
        schemaIdentityHash: release.schemaIdentityHash,
        buildIdentityHash: measuredBuild,
        productionReady: isProdProfile && state.mode === "active",
      });
    },
    content: Object.freeze({
      async listTools(): Promise<readonly McpToolDefinition[]> {
        const { state, release } = inspectActiveStateAndRelease();
        if (state.mode === "prepared" || !isProductionReleaseManifest(release)) {
          return Object.freeze([STATUS_TOOL_DEFINITION]);
        }
        return V2_PUBLIC_TOOL_DEFINITIONS;
      },
      async invoke(name: string, argumentsValue: unknown): Promise<unknown> {
        const { state, release } = inspectActiveStateAndRelease();
        if (state.mode === "prepared" || !isProductionReleaseManifest(release)) {
          await DENY_FRESH_START_PROMOTION.verify(new Uint8Array(), "");
          throw new FreshStartError("FRESH_START_RELEASE_NOT_READY");
        }
        if (state.mode === "disabled") {
          throw new FreshStartError("FRESH_START_ADMISSION_DENIED");
        }
        if (
          typeof argumentsValue === "object"
          && argumentsValue !== null
          && !Array.isArray(argumentsValue)
        ) {
          const argObj = argumentsValue as Record<string, unknown>;
          const rawProjectRoot =
            typeof argObj.projectRoot === "string"
              ? argObj.projectRoot
              : typeof argObj.workspaceRoot === "string"
                ? argObj.workspaceRoot
                : "";
          if (rawProjectRoot.trim().length > 0) {
            const routed = await resolveRoutedFoundation(rawProjectRoot);
            if (routed) {
              const { projectRoot: _p, workspaceRoot: _w, ...forwardedArgs } = argObj;
              return routed.content.invoke(name, forwardedArgs);
            }
          }
        }
        return getRouter(state).invoke(name, argumentsValue, state, release);
      },
    }),
    async close(): Promise<void> {
      if (!closed) {
        const childFoundations = [...routedFoundations.values()];
        routedFoundations.clear();
        await Promise.allSettled(
          childFoundations.map(async (fPromise) => {
            try {
              const f = await fPromise;
              await f.close();
            } catch {
              // Ignore child close failure
            }
          }),
        );
        try {
          router?.close();
        } finally {
          connection.close();
          closed = true;
        }
      }
    },
  });
  try {
    await foundation.status();
    return foundation;
  } catch (primary) {
    try {
      await foundation.close();
    } catch {
      /* Startup already fails; retain its primary diagnostic. */
    }
    throw primary;
  }
}
