import { realpathSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type {
  ProjectContext,
  ProjectId,
  ProjectStoreRoute,
  StoreId,
  VaultId,
} from "../identity/contracts.js";
import type {
  ProjectStoreIdentity,
  ProjectStoreIdentityProbe,
} from "../identity/project-binding.service.js";
import type { ProjectStoreUpgradePlan } from "../storage/project-store-upgrade.service.js";
import { PROJECT_STORE_MIGRATIONS } from "../storage/migrations/registry.js";
import { NodeSqliteDriver } from "../storage/node-sqlite-driver.js";
import { inspectStoreSchema } from "../storage/schema-compatibility.js";
import type { SqliteDriver, SqliteRow } from "../storage/sqlite-driver.js";
import { DEFAULT_BUSY_TIMEOUT_MS } from "./runtime-capabilities.js";

export class ProjectStoreUpgradeProbeError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ProjectStoreUpgradeProbeError";
  }
}

export interface ProjectStoreUpgradeProbeDependencies {
  sqliteDriver?: SqliteDriver;
}

function fail(code: string): never {
  throw new ProjectStoreUpgradeProbeError(code);
}

function canonicalEventsPath(route: ProjectStoreRoute): string {
  try {
    const requested = resolve(route.eventsPath);
    const canonical = resolve(realpathSync.native(requested));
    if (!statSync(canonical).isFile()) fail("STORE_UNAVAILABLE");
    const same = process.platform === "win32"
      ? requested.toLowerCase() === canonical.toLowerCase()
      : requested === canonical;
    const routedRoot = resolve(route.storeRoot);
    const actualRoot = resolve(dirname(canonical));
    const sameRoot = process.platform === "win32"
      ? routedRoot.toLowerCase() === actualRoot.toLowerCase()
      : routedRoot === actualRoot;
    if (!same || !sameRoot) fail("STORE_ROUTE_INVALID");
    return canonical;
  } catch (error) {
    if (error instanceof ProjectStoreUpgradeProbeError) throw error;
    fail("STORE_UNAVAILABLE");
  }
}

function requiredString(row: SqliteRow | undefined, name: string): string {
  const value = row?.[name];
  if (typeof value !== "string" || value.length === 0) fail("STORE_UNAVAILABLE");
  return value;
}

export class ProjectStoreUpgradeProbe implements ProjectStoreIdentityProbe {
  readonly #driver: Promise<SqliteDriver>;

  constructor(dependencies: ProjectStoreUpgradeProbeDependencies = {}) {
    this.#driver = dependencies.sqliteDriver === undefined
      ? import("node:sqlite").then((sqlite) => new NodeSqliteDriver(sqlite))
      : Promise.resolve(dependencies.sqliteDriver);
  }

  async inspect(context: ProjectContext): Promise<ProjectStoreUpgradePlan> {
    return this.inspectRoute(context.binding.storeRoute, {
      projectId: context.binding.projectId,
      vaultId: context.binding.vaultId,
      storeId: context.binding.storeId,
    });
  }

  async verify(
    route: ProjectStoreRoute,
    expected: { projectId: ProjectId; vaultId: VaultId; storeId: StoreId },
  ): Promise<void> {
    await this.inspectRoute(route, expected);
  }

  async inspectExisting(
    route: ProjectStoreRoute,
    expected: { projectId: ProjectId; vaultId: VaultId },
  ): Promise<ProjectStoreIdentity> {
    const inspected = await this.inspectRoute(route, expected);
    return {
      projectId: inspected.projectId as ProjectId,
      vaultId: expected.vaultId,
      storeId: inspected.storeId as StoreId,
    };
  }

  private async inspectRoute(
    route: ProjectStoreRoute,
    expected: { projectId: ProjectId; vaultId: VaultId; storeId?: StoreId },
  ): Promise<ProjectStoreUpgradePlan> {
    const path = canonicalEventsPath(route);
    const driver = await this.#driver;
    const connection = driver.open(path, {
      mode: "read-only-existing",
      busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS,
    });
    try {
      const journal = connection.prepare("PRAGMA journal_mode").get()?.journal_mode;
      if (typeof journal !== "string" || journal.toLowerCase() !== "wal") {
        fail("STORE_UNAVAILABLE");
      }
      const inspection = inspectStoreSchema(connection, PROJECT_STORE_MIGRATIONS);
      const rows = connection.prepare(`
        SELECT project_id, vault_id, store_id
        FROM project_meta
        WHERE singleton = 1
      `).all();
      if (rows.length !== 1) fail("STORE_UNAVAILABLE");
      const projectId = requiredString(rows[0], "project_id");
      const vaultId = requiredString(rows[0], "vault_id");
      const storeId = requiredString(rows[0], "store_id");
      if (projectId !== expected.projectId) fail("PROJECT_ID_MISMATCH");
      if (vaultId !== expected.vaultId) fail("VAULT_ID_MISMATCH");
      if (expected.storeId !== undefined && storeId !== expected.storeId) {
        fail("STORE_ID_MISMATCH");
      }
      return Object.freeze({
        projectId,
        storeId,
        appliedVersion: inspection.appliedVersion,
        targetVersion: inspection.targetVersion,
        pending: inspection.pending,
        status: inspection.status,
      });
    } finally {
      connection.close();
    }
  }
}
