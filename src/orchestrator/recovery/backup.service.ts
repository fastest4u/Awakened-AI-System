import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { FreshStartError } from "../fresh-start/contracts.js";
import {
  assertFreshStartOwnedDirectory,
  assertFreshStartPaths,
  canonicalFreshStartPath,
  freshStartPathContains,
} from "../fresh-start/fresh-start-paths.js";
import { SqliteFreshStartRepository } from "../fresh-start/fresh-start.repository.js";
import type { ProjectContext } from "../identity/contracts.js";
import { computeProjectContextFingerprint } from "../identity/project-binding.service.js";
import {
  GitWorkspaceResolver,
  SpawnSyncGitCommandRunner,
} from "../identity/git-workspace.resolver.js";
import { ProjectDescriptorRepository } from "../identity/project-descriptor.repository.js";
import { ProjectStoreRouter } from "../identity/project-store.router.js";
import { StoreManifestRepository } from "../identity/store-manifest.repository.js";
import { EventIntegrityService } from "../integrity/event-integrity.service.js";
import { OperationalKeyCustodyProvider } from "../keys/operational-key-custody.js";
import { canonicalJson } from "../serialization/canonical-json.js";
import { GENESIS_GLOBAL_HASH } from "../storage/event-chain-constants.js";
import { MaintenanceFence } from "../storage/maintenance-fence.js";
import { PROJECT_STORE_MIGRATIONS } from "../storage/migrations/registry.js";
import { NodeSqliteDriver } from "../storage/node-sqlite-driver.js";
import type {
  BackupHealthStatus,
  BackupTriggerReason,
  V2BackupManifestV1,
} from "./contracts.js";

const DEFAULT_MAX_ACTIVE_BACKUP_AGE_MS = 3_600_000;
const BACKUP_LEASE_TTL_MS = 60_000;

function sha256File(filePath: string): string {
  const bytes = readFileSync(filePath);
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256CanonicalJson(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function computeBackupManifestDigest(
  manifest: Omit<V2BackupManifestV1, "backupManifestDigest">,
): string {
  return sha256CanonicalJson({
    domain: "v2-backup-manifest-v1",
    ...manifest,
  });
}

export function resolveVaultStoreInfo(
  v2VaultRoot: string,
  projectRoot?: string,
): {
  readonly canonicalVaultRoot: string;
  readonly canonicalProjectRoot: string;
  readonly storeRoot: string;
  readonly eventsPath: string;
  readonly storeManifestPath: string;
  readonly descriptorPath: string;
  readonly projectId: string;
  readonly vaultId: string;
  readonly storeId: string;
} {
  const canonicalVaultRoot = canonicalFreshStartPath(v2VaultRoot);
  const descriptorRepo = new ProjectDescriptorRepository();
  const inspectedDescriptor = descriptorRepo.inspect(canonicalVaultRoot);
  if (inspectedDescriptor.status !== "valid") {
    throw new FreshStartError("FRESH_START_RECOVERY_REQUIRED");
  }
  const descriptor = inspectedDescriptor.descriptor;
  const descriptorPath = join(canonicalVaultRoot, ".memory-mcp", "project-identity.json");
  const initJournalPath = join(canonicalVaultRoot, ".memory-mcp", "fresh-start-init.json");

  let resolvedProjectRoot = projectRoot ? canonicalFreshStartPath(projectRoot) : "";
  let resolvedStoreRoot = "";

  if (existsSync(initJournalPath)) {
    try {
      const parsed = JSON.parse(readFileSync(initJournalPath, "utf8")) as {
        paths?: { projectRoot?: string };
        storeRoot?: string;
      };
      if (!resolvedProjectRoot && typeof parsed.paths?.projectRoot === "string") {
        resolvedProjectRoot = canonicalFreshStartPath(parsed.paths.projectRoot);
      }
      if (typeof parsed.storeRoot === "string" && parsed.storeRoot.length > 0) {
        resolvedStoreRoot = canonicalFreshStartPath(parsed.storeRoot);
      }
    } catch {
      // Fall back to router or vault-local path
    }
  }

  if (!resolvedStoreRoot) {
    if (resolvedProjectRoot) {
      const workspace = new GitWorkspaceResolver(new SpawnSyncGitCommandRunner()).inspect(
        resolvedProjectRoot,
        descriptor,
      );
      const route = new ProjectStoreRouter().route(
        descriptor,
        canonicalVaultRoot,
        workspace,
      );
      resolvedStoreRoot = canonicalFreshStartPath(route.storeRoot);
    } else {
      resolvedStoreRoot = join(canonicalVaultRoot, ".memory-mcp", "v2");
    }
  }

  if (!resolvedProjectRoot) {
    resolvedProjectRoot = canonicalVaultRoot;
  }

  const eventsPath = join(resolvedStoreRoot, "events.sqlite");
  const storeManifestPath = join(resolvedStoreRoot, "store-manifest.json");
  if (!existsSync(storeManifestPath) || !existsSync(eventsPath)) {
    throw new FreshStartError("FRESH_START_RECOVERY_REQUIRED");
  }
  const parsedManifest = JSON.parse(readFileSync(storeManifestPath, "utf8")) as {
    storeId?: string;
  };
  if (typeof parsedManifest.storeId !== "string" || parsedManifest.storeId.length === 0) {
    throw new FreshStartError("FRESH_START_RECOVERY_REQUIRED");
  }

  return {
    canonicalVaultRoot,
    canonicalProjectRoot: resolvedProjectRoot,
    storeRoot: resolvedStoreRoot,
    eventsPath,
    storeManifestPath,
    descriptorPath,
    projectId: descriptor.projectId,
    vaultId: descriptor.vaultId,
    storeId: parsedManifest.storeId,
  };
}

export class V2BackupService {
  async createBackup(input: {
    readonly projectRoot: string;
    readonly v2VaultRoot: string;
    readonly v1ArchiveRoot: string;
    readonly outputDirectory: string;
    readonly reason: BackupTriggerReason;
    readonly now?: string;
  }): Promise<V2BackupManifestV1> {
    const paths = await assertFreshStartPaths({
      projectRoot: input.projectRoot,
      v2VaultRoot: input.v2VaultRoot,
      v1ArchiveRoot: input.v1ArchiveRoot,
    });
    const outputDir = canonicalFreshStartPath(resolve(input.outputDirectory));

    for (const protectedRoot of [paths.projectRoot, paths.v2VaultRoot, paths.v1ArchiveRoot]) {
      if (
        freshStartPathContains(outputDir, protectedRoot)
        || freshStartPathContains(protectedRoot, outputDir)
      ) {
        throw new FreshStartError("FRESH_START_PATH_OVERLAP");
      }
    }

    const descriptorRepo = new ProjectDescriptorRepository();
    const inspectedDescriptor = descriptorRepo.inspect(paths.v2VaultRoot);
    if (inspectedDescriptor.status !== "valid") {
      throw new FreshStartError("FRESH_START_RECOVERY_REQUIRED");
    }
    const workspace = new GitWorkspaceResolver(new SpawnSyncGitCommandRunner()).inspect(
      paths.projectRoot,
      inspectedDescriptor.descriptor,
    );
    const route = new ProjectStoreRouter().route(
      inspectedDescriptor.descriptor,
      paths.v2VaultRoot,
      workspace,
    );
    assertFreshStartOwnedDirectory(route.storeRoot, paths.v1ArchiveRoot);
    const canonicalStoreRoot = canonicalFreshStartPath(route.storeRoot);
    if (
      freshStartPathContains(outputDir, canonicalStoreRoot)
      || freshStartPathContains(canonicalStoreRoot, outputDir)
    ) {
      throw new FreshStartError("FRESH_START_PATH_OVERLAP");
    }

    if (existsSync(outputDir) && readdirSync(outputDir).length > 0) {
      throw new FreshStartError("FRESH_START_DESTINATION_NOT_EMPTY");
    }

    const inspectedManifest = new StoreManifestRepository().inspect(route, {
      projectId: inspectedDescriptor.descriptor.projectId,
      vaultId: inspectedDescriptor.descriptor.vaultId,
    });
    if (inspectedManifest.status !== "valid") {
      throw new FreshStartError("FRESH_START_RECOVERY_REQUIRED");
    }

    const identity = {
      projectId: inspectedDescriptor.descriptor.projectId,
      vaultId: inspectedDescriptor.descriptor.vaultId,
      storeId: inspectedManifest.manifest.storeId,
    };
    const nowIso = input.now ?? new Date().toISOString();
    const nowMs = Date.parse(nowIso);
    if (!Number.isFinite(nowMs)) {
      throw new FreshStartError("FRESH_START_INPUT_INVALID");
    }
    const leaseExpiresAt = new Date(nowMs + BACKUP_LEASE_TTL_MS).toISOString();
    const backupId = randomUUID();

    const driver = new NodeSqliteDriver({ DatabaseSync });
    const connection = driver.open(route.eventsPath, {
      mode: "existing",
      busyTimeoutMs: 5_000,
      bindFileIdentity: true,
    });

    let releaseJson = "";
    let releaseId = "";
    let terminalGlobalPosition = "0";
    let terminalGlobalHash = GENESIS_GLOBAL_HASH;
    let eventStoreSchemaVersion = 9;

    const fence = new MaintenanceFence();
    let lease: ReturnType<MaintenanceFence["acquire"]> | undefined;
    try {
      lease = fence.acquire(connection, `backup:${backupId}`, leaseExpiresAt, nowIso);
      fence.assertReady(connection, lease, nowIso);

      mkdirSync(outputDir, { recursive: true });

      const freshStartRepo = new SqliteFreshStartRepository(connection);
      const { state, release } = freshStartRepo.transact(identity, (tx) => {
        const s = tx.state();
        if (!s) {
          throw new FreshStartError("FRESH_START_RECOVERY_REQUIRED");
        }
        return { state: s, release: tx.release(s.releaseId) };
      });
      releaseId = state.releaseId;
      if (!release) {
        throw new FreshStartError("FRESH_START_RECOVERY_REQUIRED");
      }
      releaseJson = `${canonicalJson(release)}\n`;

      const tailRow = connection
        .prepare(
          `SELECT global_position, event_hash
           FROM events
           WHERE project_id = $projectId
           ORDER BY global_position DESC
           LIMIT 1`,
        )
        .get({ $projectId: identity.projectId }) as
        | { global_position?: bigint; event_hash?: string }
        | undefined;
      if (tailRow && typeof tailRow.global_position === "bigint" && typeof tailRow.event_hash === "string") {
        terminalGlobalPosition = tailRow.global_position.toString();
        terminalGlobalHash = tailRow.event_hash;
      }

      const schemaRow = connection
        .prepare(`SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations`)
        .get() as { version?: bigint | number } | undefined;
      if (schemaRow?.version !== undefined) {
        eventStoreSchemaVersion = Number(schemaRow.version);
      }

      connection.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      const backupEventsPath = join(outputDir, "events.sqlite");
      const escapedBackupEventsPath = backupEventsPath.replace(/'/g, "''");
      connection.exec(`VACUUM INTO '${escapedBackupEventsPath}'`);
    } finally {
      if (lease) {
        try {
          fence.release(connection, lease, false, nowIso);
        } catch {
          // Preserve primary error if release fails
        }
      }
      connection.close();
    }

    const backupEventsPath = join(outputDir, "events.sqlite");
    const backupDescriptorPath = join(outputDir, "project-identity.json");
    const backupStoreManifestPath = join(outputDir, "store-manifest.json");
    const backupReleasePath = join(outputDir, "fresh-start-release.json");
    const backupErasureFencesPath = join(outputDir, "erasure-fences.json");
    const backupManifestPath = join(outputDir, "backup-manifest.json");

    try {
      // Ensure the backed-up events.sqlite has idle maintenance_state, WAL header flag, and no WAL/SHM sidecars
      const snapshotDb = new DatabaseSync(backupEventsPath);
      try {
        snapshotDb.exec("PRAGMA journal_mode = WAL");
        snapshotDb.exec(`
          UPDATE maintenance_state
          SET mode = 'idle',
              owner_id = NULL,
              lease_expires_at = NULL,
              requested_at = NULL
          WHERE singleton = 1;
          DELETE FROM maintenance_required_executors;
          DELETE FROM maintenance_acknowledgements;
        `);
        snapshotDb.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      } finally {
        snapshotDb.close();
      }
      rmSync(`${backupEventsPath}-wal`, { force: true });
      rmSync(`${backupEventsPath}-shm`, { force: true });

      const sourceDescriptorPath = join(paths.v2VaultRoot, ".memory-mcp", "project-identity.json");
      copyFileSync(sourceDescriptorPath, backupDescriptorPath);
      copyFileSync(route.storeManifestPath, backupStoreManifestPath);
      writeFileSync(backupReleasePath, releaseJson, "utf8");

      // Also preserve fresh-start-init.json and genesis projection if present for seamless isolated restore
      const sourceInitJournalPath = join(paths.v2VaultRoot, ".memory-mcp", "fresh-start-init.json");
      if (existsSync(sourceInitJournalPath)) {
        copyFileSync(sourceInitJournalPath, join(outputDir, "fresh-start-init.json"));
      }
      const sourceGenesisProjectionPath = join(
        route.storeRoot,
        "fresh-start-projection",
        "projections-3-1.sqlite",
      );
      if (existsSync(sourceGenesisProjectionPath)) {
        const targetGenesisProjectionDir = join(outputDir, "fresh-start-projection");
        mkdirSync(targetGenesisProjectionDir, { recursive: true });
        copyFileSync(
          sourceGenesisProjectionPath,
          join(targetGenesisProjectionDir, "projections-3-1.sqlite"),
        );
      }

      const custody = new OperationalKeyCustodyProvider({
        storeRoot: route.storeRoot,
        projectId: identity.projectId,
        storeId: identity.storeId,
        paths,
      });
      let erasureFencesJson = "[]\n";
      try {
        const fences = custody.listErasureFences();
        erasureFencesJson = `${canonicalJson(fences)}\n`;
      } finally {
        custody.close();
      }
      writeFileSync(backupErasureFencesPath, erasureFencesJson, "utf8");

      // Copy custody-recovery.sqlite snapshot so isolated restore can recover key versions & envelopes
      const sourceCustodyPath = join(route.storeRoot, "custody-recovery.sqlite");
      if (existsSync(sourceCustodyPath)) {
        const custodyDb = new DatabaseSync(sourceCustodyPath);
        try {
          const backupCustodyPath = join(outputDir, "custody-recovery.sqlite");
          const escapedCustodyPath = backupCustodyPath.replace(/'/g, "''");
          custodyDb.exec(`VACUUM INTO '${escapedCustodyPath}'`);
        } finally {
          custodyDb.close();
        }
      }

      // Verify snapshot integrity using EventIntegrityService
      const verifyConn = driver.open(backupEventsPath, {
        mode: "existing",
        busyTimeoutMs: 5_000,
      });
      try {
        const backupStoreRoute = {
          ...route,
          storeRoot: outputDir,
          eventsPath: backupEventsPath,
          storeManifestPath: backupStoreManifestPath,
        };
        const baseBinding = {
          projectBindingId: randomUUID(),
          generation: 1,
          source: "stdio-explicit-root" as const,
          projectId: identity.projectId,
          vaultId: identity.vaultId,
          storeId: identity.storeId,
          workspaceId: workspace.workspaceId,
          descriptorPath: backupDescriptorPath,
          vaultRoot: paths.v2VaultRoot,
          projectRoot: paths.projectRoot,
          workspace,
          storeRoute: backupStoreRoute,
          clientNamespace: "backup-verifier",
          clientInstanceId: "backup-verifier-instance",
          actorRole: "primary" as const,
          establishedAt: nowIso,
          contextFingerprint: "",
        };
        const backupProjectContext: ProjectContext = {
          workspace,
          checkedAt: nowIso,
          binding: {
            ...baseBinding,
            contextFingerprint: computeProjectContextFingerprint(baseBinding),
          },
        };
        const integrityReport = new EventIntegrityService(
          verifyConn,
          PROJECT_STORE_MIGRATIONS,
        ).fullCheck(backupProjectContext);
        if (!integrityReport.ok) {
          throw new FreshStartError("FRESH_START_RECOVERY_CORRUPT");
        }
        verifyConn.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      } finally {
        verifyConn.close();
      }
      rmSync(`${backupEventsPath}-wal`, { force: true });
      rmSync(`${backupEventsPath}-shm`, { force: true });

      const files = Object.freeze({
        eventsSqliteSha256: sha256File(backupEventsPath),
        freshStartReleaseSha256: sha256File(backupReleasePath),
        projectIdentitySha256: sha256File(backupDescriptorPath),
        storeManifestSha256: sha256File(backupStoreManifestPath),
        erasureFencesSha256: sha256File(backupErasureFencesPath),
      });

      const unsignedManifest: Omit<V2BackupManifestV1, "backupManifestDigest"> = {
        manifestVersion: 1,
        backupId,
        projectId: identity.projectId,
        vaultId: identity.vaultId,
        storeId: identity.storeId,
        releaseId,
        createdAt: nowIso,
        reason: input.reason,
        terminalGlobalPosition,
        terminalGlobalHash,
        eventStoreSchemaVersion,
        projectionSchemaVersion: 3,
        files,
      };
      const backupManifestDigest = computeBackupManifestDigest(unsignedManifest);
      const manifest: V2BackupManifestV1 = Object.freeze({
        ...unsignedManifest,
        backupManifestDigest,
      });

      writeFileSync(backupManifestPath, `${canonicalJson(manifest)}\n`, "utf8");

      const custodyForReceipt = new OperationalKeyCustodyProvider({
        storeRoot: route.storeRoot,
        projectId: identity.projectId,
        storeId: identity.storeId,
        paths,
      });
      try {
        custodyForReceipt.recordBackupReceipt({
          backupId: manifest.backupId,
          projectId: manifest.projectId,
          storeId: manifest.storeId,
          releaseId: manifest.releaseId,
          backupPath: outputDir,
          terminalEventPosition: manifest.terminalGlobalPosition,
          terminalEventHash: manifest.terminalGlobalHash,
          manifestSha256: manifest.backupManifestDigest,
          createdAt: manifest.createdAt,
        });
      } finally {
        custodyForReceipt.close();
      }

      return manifest;
    } catch (error) {
      rmSync(outputDir, { recursive: true, force: true });
      throw error;
    }
  }

  async inspectHealth(input: {
    readonly v2VaultRoot: string;
    readonly projectRoot?: string;
    readonly now?: string;
    readonly maxActiveBackupAgeMs?: number;
  }): Promise<BackupHealthStatus> {
    const info = resolveVaultStoreInfo(input.v2VaultRoot, input.projectRoot);
    const nowIso = input.now ?? new Date().toISOString();
    const nowMs = Date.parse(nowIso);
    const maxAgeMs = input.maxActiveBackupAgeMs ?? DEFAULT_MAX_ACTIVE_BACKUP_AGE_MS;

    const driver = new NodeSqliteDriver({ DatabaseSync });
    const connection = driver.open(info.eventsPath, {
      mode: "read-only-existing",
      busyTimeoutMs: 5_000,
    });
    let currentGlobalPosition = "0";
    try {
      const row = connection
        .prepare(
          `SELECT COALESCE(MAX(global_position), 0) AS pos
           FROM events
           WHERE project_id = $projectId`,
        )
        .get({ $projectId: info.projectId }) as { pos?: bigint | number } | undefined;
      currentGlobalPosition = BigInt(row?.pos ?? 0).toString();
    } finally {
      connection.close();
    }

    const custody = new OperationalKeyCustodyProvider({
      storeRoot: info.storeRoot,
      projectId: info.projectId,
      storeId: info.storeId,
    });
    let latestReceipt: ReturnType<OperationalKeyCustodyProvider["latestBackupReceipt"]> = null;
    try {
      latestReceipt = custody.latestBackupReceipt();
    } finally {
      custody.close();
    }

    if (!latestReceipt) {
      const hasUnbackedEvents = BigInt(currentGlobalPosition) > 0n;
      return Object.freeze({
        healthy: false,
        backupOverdue: true,
        lastVerifiedBackupId: null,
        lastVerifiedBackupAt: null,
        lastBackedUpGlobalPosition: null,
        currentGlobalPosition,
        hasUnbackedEvents,
      });
    }

    const hasUnbackedEvents =
      BigInt(currentGlobalPosition) > BigInt(latestReceipt.terminalEventPosition);
    const lastBackupMs = Date.parse(latestReceipt.createdAt);
    const ageMs = Number.isFinite(nowMs) && Number.isFinite(lastBackupMs)
      ? Math.max(0, nowMs - lastBackupMs)
      : 0;
    const backupOverdue = hasUnbackedEvents && ageMs > maxAgeMs;

    return Object.freeze({
      healthy: !backupOverdue,
      backupOverdue,
      lastVerifiedBackupId: latestReceipt.backupId,
      lastVerifiedBackupAt: latestReceipt.createdAt,
      lastBackedUpGlobalPosition: latestReceipt.terminalEventPosition,
      currentGlobalPosition,
      hasUnbackedEvents,
    });
  }
}

export class V2BackupScheduler {
  constructor(private readonly backupService: V2BackupService = new V2BackupService()) {}

  async runIfDue(input: {
    readonly projectRoot: string;
    readonly v2VaultRoot: string;
    readonly v1ArchiveRoot: string;
    readonly backupRootDirectory: string;
    readonly now?: string;
    readonly maxActiveBackupAgeMs?: number;
  }): Promise<V2BackupManifestV1 | null> {
    const health = await this.backupService.inspectHealth({
      v2VaultRoot: input.v2VaultRoot,
      projectRoot: input.projectRoot,
      now: input.now,
      maxActiveBackupAgeMs: input.maxActiveBackupAgeMs,
    });
    if (!health.backupOverdue) {
      return null;
    }
    const nowIso = input.now ?? new Date().toISOString();
    const safeStamp = nowIso.replace(/[:.]/g, "-");
    const outputDirectory = join(
      input.backupRootDirectory,
      `hourly-active-${safeStamp}-${randomUUID().slice(0, 8)}`,
    );
    return this.backupService.createBackup({
      projectRoot: input.projectRoot,
      v2VaultRoot: input.v2VaultRoot,
      v1ArchiveRoot: input.v1ArchiveRoot,
      outputDirectory,
      reason: "hourly-active",
      now: nowIso,
    });
  }

  async onPreUpgrade(input: {
    readonly projectRoot: string;
    readonly v2VaultRoot: string;
    readonly v1ArchiveRoot: string;
    readonly backupRootDirectory: string;
    readonly now?: string;
  }): Promise<V2BackupManifestV1> {
    const nowIso = input.now ?? new Date().toISOString();
    const safeStamp = nowIso.replace(/[:.]/g, "-");
    const outputDirectory = join(
      input.backupRootDirectory,
      `pre-upgrade-${safeStamp}-${randomUUID().slice(0, 8)}`,
    );
    return this.backupService.createBackup({
      projectRoot: input.projectRoot,
      v2VaultRoot: input.v2VaultRoot,
      v1ArchiveRoot: input.v1ArchiveRoot,
      outputDirectory,
      reason: "pre-upgrade",
      now: nowIso,
    });
  }

  async onOrderlyShutdown(input: {
    readonly projectRoot: string;
    readonly v2VaultRoot: string;
    readonly v1ArchiveRoot: string;
    readonly backupRootDirectory: string;
    readonly now?: string;
  }): Promise<V2BackupManifestV1 | null> {
    const health = await this.backupService.inspectHealth({
      v2VaultRoot: input.v2VaultRoot,
      projectRoot: input.projectRoot,
      now: input.now,
    });
    if (!health.hasUnbackedEvents && health.lastVerifiedBackupId !== null) {
      return null;
    }
    const nowIso = input.now ?? new Date().toISOString();
    const safeStamp = nowIso.replace(/[:.]/g, "-");
    const outputDirectory = join(
      input.backupRootDirectory,
      `orderly-shutdown-${safeStamp}-${randomUUID().slice(0, 8)}`,
    );
    return this.backupService.createBackup({
      projectRoot: input.projectRoot,
      v2VaultRoot: input.v2VaultRoot,
      v1ArchiveRoot: input.v1ArchiveRoot,
      outputDirectory,
      reason: "orderly-shutdown",
      now: nowIso,
    });
  }
}
