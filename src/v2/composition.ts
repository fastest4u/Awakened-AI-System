import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { FreshStartInitializer } from "../orchestrator/fresh-start/fresh-start-initializer.js";
import {
  assertFreshStartOwnedDirectory,
  assertFreshStartPaths,
  freshStartPathContains,
  type FreshStartPaths,
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
  statusForProject?(projectRoot: string): Promise<FreshStartStatus>;
  close(): Promise<void>;
  readonly content: V2ContentAdapters;
}

export function validateRoutedProjectRoot(
  rawTargetProjectRoot: string,
  hostPaths: FreshStartPaths,
): string | null {
  const trimmed = rawTargetProjectRoot.trim();
  if (!trimmed) return null;
  if (trimmed.includes("\0") || !isAbsolute(trimmed)) {
    throw new FreshStartError("FRESH_START_INPUT_INVALID");
  }
  const resolvedTarget = resolve(trimmed);
  const resolvedHome = resolve(hostPaths.projectRoot);
  if (
    resolvedTarget === resolvedHome ||
    (process.platform === "win32" && resolvedTarget.toLowerCase() === resolvedHome.toLowerCase())
  ) {
    return null;
  }
  if (
    freshStartPathContains(hostPaths.v1ArchiveRoot, resolvedTarget) ||
    freshStartPathContains(resolvedTarget, hostPaths.v1ArchiveRoot) ||
    freshStartPathContains(hostPaths.v2VaultRoot, resolvedTarget) ||
    freshStartPathContains(resolvedTarget, hostPaths.v2VaultRoot)
  ) {
    throw new FreshStartError("FRESH_START_PATH_OVERLAP");
  }
  if (!existsSync(resolvedTarget)) {
    throw new FreshStartError("FRESH_START_INPUT_INVALID");
  }
  let targetStat;
  try {
    targetStat = lstatSync(resolvedTarget);
  } catch {
    throw new FreshStartError("FRESH_START_INPUT_INVALID");
  }
  if (!targetStat.isDirectory() && !targetStat.isSymbolicLink()) {
    throw new FreshStartError("FRESH_START_INPUT_INVALID");
  }
  let canonicalTarget: string;
  try {
    canonicalTarget = realpathSync.native(resolvedTarget);
  } catch {
    throw new FreshStartError("FRESH_START_INPUT_INVALID");
  }
  let canonicalStat;
  try {
    canonicalStat = statSync(canonicalTarget);
  } catch {
    throw new FreshStartError("FRESH_START_INPUT_INVALID");
  }
  if (!canonicalStat.isDirectory()) {
    throw new FreshStartError("FRESH_START_INPUT_INVALID");
  }
  const canonicalHome = existsSync(resolvedHome)
    ? realpathSync.native(resolvedHome)
    : resolvedHome;
  if (
    canonicalTarget === canonicalHome ||
    (process.platform === "win32" && canonicalTarget.toLowerCase() === canonicalHome.toLowerCase())
  ) {
    return null;
  }
  if (
    freshStartPathContains(hostPaths.v1ArchiveRoot, canonicalTarget) ||
    freshStartPathContains(canonicalTarget, hostPaths.v1ArchiveRoot) ||
    freshStartPathContains(hostPaths.v2VaultRoot, canonicalTarget) ||
    freshStartPathContains(canonicalTarget, hostPaths.v2VaultRoot)
  ) {
    throw new FreshStartError("FRESH_START_PATH_OVERLAP");
  }
  return canonicalTarget;
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
  readonly allowBootstrap?: boolean;
  readonly syncBuild?: boolean;
  readonly ensureActive?: boolean;
}): Promise<V2LaunchConfig> {
  if (!isAbsolute(options.projectRoot) || options.projectRoot.includes("\0")) {
    throw new FreshStartError("FRESH_START_CONFIG_INVALID");
  }
  const allowBootstrap = options.allowBootstrap !== false;
  if (allowBootstrap) {
    mkdirSync(options.projectRoot, { recursive: true });
  } else if (!existsSync(options.projectRoot)) {
    throw new FreshStartError("FRESH_START_INPUT_INVALID");
  }
  const canonicalProjectRoot = realpathSync.native(resolve(options.projectRoot));
  const rawV2VaultRoot = options.v2VaultRoot
    ? resolve(options.v2VaultRoot)
    : join(canonicalProjectRoot, "memory-v2");
  const memoryArchiveDir = join(canonicalProjectRoot, "memory");
  const altArchiveDir = join(canonicalProjectRoot, "archive");
  const placeholderArchiveDir = join(canonicalProjectRoot, ".v1-archive-placeholder");
  const defaultArchiveCandidate = existsSync(memoryArchiveDir)
    ? memoryArchiveDir
    : existsSync(altArchiveDir)
      ? altArchiveDir
      : placeholderArchiveDir;
  const rawV1ArchiveRoot = options.v1ArchiveRoot
    ? resolve(options.v1ArchiveRoot)
    : defaultArchiveCandidate;

  // Never create or write inside legacy `memory/` (frozen read-only V1 archive).
  if (!existsSync(rawV1ArchiveRoot) && allowBootstrap && rawV1ArchiveRoot === placeholderArchiveDir) {
    mkdirSync(placeholderArchiveDir, { recursive: true });
  }

  const measuredBuild = inspectV2Build(options.entryUrl);
  const schemaIdentityHash = expectedSchemaFingerprint(PROJECT_STORE_MIGRATIONS);
  const descriptorFile = join(rawV2VaultRoot, ".memory-mcp", "project-identity.json");
  const isInitialized = existsSync(descriptorFile);

  if (!isInitialized) {
    if (!allowBootstrap) {
      throw new FreshStartError("FRESH_START_INPUT_INVALID");
    }
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
  interface RoutedFoundationEntry {
    promise: Promise<V2Foundation>;
    activeCalls: number;
    pendingClose: boolean;
    bootstrappedActive: boolean;
  }
  const routedFoundations = new Map<string, RoutedFoundationEntry>();
  const autoHealEnabled =
    options?.autoHealBuildSync === true || process.env.MEMORY_V2_AUTO_SYNC_BUILD === "1";

  const READ_ONLY_ROUTED_TOOLS = new Set<string>([
    "memory_v2Status",
    "memory_get",
    "memory_list",
    "memory_search",
    "memory_recent",
    "memory_contextPack",
    "memory_selfCheck",
    "memory_followUpRadar",
    "memory_awaken",
    "memory_lifecycleStatus",
    "memory_verifyVault",
    "memory_verifyNote",
    "memory_verifySourceTruth",
    "memory_findDuplicates",
    "memory_checkStaleness",
  ]);

  const releaseEvictedEntry = (entry: RoutedFoundationEntry): void => {
    entry.pendingClose = true;
    if (entry.activeCalls === 0) {
      void entry.promise.then((f) => f.close()).catch(() => undefined);
    }
  };

  const withRoutedFoundation = async <T>(
    rawTargetProjectRoot: string,
    allowAutoBootstrap: boolean,
    fn: (routed: V2Foundation) => Promise<T>,
  ): Promise<{ readonly routed: true; readonly value: T } | { readonly routed: false }> => {
    const canonicalTarget = validateRoutedProjectRoot(rawTargetProjectRoot, paths);
    if (!canonicalTarget) {
      return { routed: false };
    }
    if (
      !allowAutoBootstrap &&
      !existsSync(join(canonicalTarget, "memory-v2", ".memory-mcp", "project-identity.json"))
    ) {
      throw new FreshStartError("FRESH_START_INPUT_INVALID");
    }

    const cacheKey =
      process.platform === "win32" ? canonicalTarget.toLowerCase() : canonicalTarget;
    let entry = routedFoundations.get(cacheKey);
    if (entry && allowAutoBootstrap && !entry.bootstrappedActive) {
      routedFoundations.delete(cacheKey);
      releaseEvictedEntry(entry);
      entry = undefined;
    }

    if (entry) {
      routedFoundations.delete(cacheKey);
      routedFoundations.set(cacheKey, entry);
    } else {
      if (routedFoundations.size >= 16) {
        let victimKey: string | undefined;
        for (const [k, candidate] of routedFoundations.entries()) {
          if (candidate.activeCalls === 0) {
            victimKey = k;
            break;
          }
        }
        if (victimKey === undefined) {
          victimKey = routedFoundations.keys().next().value;
        }
        if (victimKey !== undefined) {
          const evicted = routedFoundations.get(victimKey);
          routedFoundations.delete(victimKey);
          if (evicted) releaseEvictedEntry(evicted);
        }
      }
      const shouldSync = allowAutoBootstrap && autoHealEnabled;
      const promise = (async () => {
        const targetConfig = await ensureProjectV2StoreReady({
          projectRoot: canonicalTarget,
          ...(options?.entryUrl ? { entryUrl: options.entryUrl } : {}),
          allowBootstrap: allowAutoBootstrap,
          syncBuild: shouldSync,
          ensureActive: allowAutoBootstrap,
        });
        return createV2Foundation(targetConfig, {
          ...(options?.entryUrl ? { entryUrl: options.entryUrl } : {}),
          autoHealBuildSync: shouldSync,
        });
      })();
      entry = {
        promise,
        activeCalls: 0,
        pendingClose: false,
        bootstrappedActive: allowAutoBootstrap,
      };
      routedFoundations.set(cacheKey, entry);
    }

    entry.activeCalls += 1;
    let instance: V2Foundation;
    try {
      instance = await entry.promise;
    } catch (err) {
      entry.activeCalls -= 1;
      if (routedFoundations.get(cacheKey) === entry) {
        routedFoundations.delete(cacheKey);
      }
      throw err;
    }
    try {
      return { routed: true, value: await fn(instance) };
    } finally {
      entry.activeCalls -= 1;
      if (entry.pendingClose && entry.activeCalls === 0) {
        void entry.promise.then((f) => f.close()).catch(() => undefined);
      }
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

  const inspectActiveStateAndRelease = () => {
    if (closed) throw new FreshStartError("FRESH_START_STORAGE_FAILURE");
    if (inspectV2Build(options?.entryUrl) !== measuredBuild) throw new FreshStartError("FRESH_START_BUILD_MISMATCH");
    if (autoHealEnabled) {
      const preCheck = repository.transact(identity, (tx) => {
        const st = tx.state();
        if (!st) return null;
        const rel = tx.release(st.releaseId);
        return rel ? { state: st, release: rel } : null;
      });
      if (
        preCheck &&
        preCheck.state.mode === "active" &&
        preCheck.release.releaseId === config.releaseId &&
        preCheck.release.schemaIdentityHash === expectedSchemaFingerprint(PROJECT_STORE_MIGRATIONS) &&
        preCheck.release.configurationHash === configurationDigest(config) &&
        isProductionReleaseManifest(preCheck.release) &&
        preCheck.release.buildIdentityHash !== measuredBuild
      ) {
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
    async statusForProject(targetProjectRoot: string): Promise<FreshStartStatus> {
      inspectActiveStateAndRelease();
      const outcome = await withRoutedFoundation(targetProjectRoot, false, (routed) =>
        routed.status(),
      );
      if (outcome.routed) {
        return outcome.value;
      }
      return foundation.status();
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
            const { projectRoot: _p, workspaceRoot: _w, ...forwardedArgs } = argObj;
            const outcome = await withRoutedFoundation(
              rawProjectRoot,
              !READ_ONLY_ROUTED_TOOLS.has(name),
              (routed) => routed.content.invoke(name, forwardedArgs),
            );
            if (outcome.routed) {
              return outcome.value;
            }
          }
        }
        return getRouter(state).invoke(name, argumentsValue, state, release);
      },
    }),
    async close(): Promise<void> {
      if (!closed) {
        const childEntries = [...routedFoundations.values()];
        routedFoundations.clear();
        await Promise.allSettled(
          childEntries.map(async (entry) => {
            entry.pendingClose = true;
            try {
              const f = await entry.promise;
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
