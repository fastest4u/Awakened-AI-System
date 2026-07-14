import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  loadFrontmatterConfig,
  projectConfigPath,
  projectConfigSchemaPath,
  sampleProjectConfig,
  sampleProjectConfigSchema,
} from "../config/frontmatter.config.js";
import { diagnoseMemoryConfig, loadMemoryConfig } from "../config/memory.config.js";
import {
  assertContainedPath,
  canonicalExistingDirectory,
} from "../orchestrator/identity/canonical-path.js";
import type {
  ProjectBinding,
  ProjectContext,
  ProjectStoreRoute,
  WorkspaceSnapshot,
} from "../orchestrator/identity/contracts.js";
import {
  deriveGitWorkspaceId,
  deriveNonGitWorkspaceId,
  GitWorkspaceResolutionError,
  GitWorkspaceResolver,
  SpawnSyncGitCommandRunner,
} from "../orchestrator/identity/git-workspace.resolver.js";
import {
  computeProjectContextFingerprint,
  describeProjectBindingFailure,
  ProjectBindingError,
  ProjectBindingService,
  type ProjectBindingResolution,
  type ProjectStoreIdentityProbe,
} from "../orchestrator/identity/project-binding.service.js";
import {
  parseTrustedProjectBindingRequest,
  type TrustedProjectBindingRequest,
} from "../orchestrator/identity/project-binding.request.js";
import { parseProjectDescriptor } from "../orchestrator/identity/project-descriptor.schema.js";
import { ProjectDescriptorRepository } from "../orchestrator/identity/project-descriptor.repository.js";
import { ProjectStoreRouter } from "../orchestrator/identity/project-store.router.js";
import { parseStoreManifest } from "../orchestrator/identity/store-manifest.schema.js";
import { StoreManifestRepository } from "../orchestrator/identity/store-manifest.repository.js";
import type { IntegrityReport } from "../orchestrator/integrity/integrity.types.js";
import {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_MAX_PENDING,
  ProjectStoreExecutor,
  ProjectStoreWorkerError,
} from "../orchestrator/runtime/project-store-executor.js";
import { WorkerProjectStoreIdentityProbe } from "../orchestrator/runtime/project-store-identity-probe.js";
import { decodeIntegrityReport } from "../orchestrator/runtime/worker-protocol.js";
import {
  compareVersions,
  MINIMUM_NODE_VERSION,
  MINIMUM_SQLITE_VERSION,
  probeRuntimeCapabilities,
  type RuntimeCapabilityReport,
  type RuntimeCapabilityResult,
} from "../orchestrator/runtime/runtime-capabilities.js";
import { canonicalJson } from "../orchestrator/serialization/canonical-json.js";
import type {
  ProjectStoreBootstrapResult,
  ProjectStoreBootstrapService,
} from "../orchestrator/storage/project-store-bootstrap.service.js";
import { FrontmatterService } from "../services/frontmatter.service.js";
import { VaultService } from "../services/vault.service.js";
import { HELP, CliUsageError, type CliOptions } from "./parse-args.js";

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

export interface ProjectInitializationSummary {
  projectRoot: string;
  vaultRoot: string;
  routeState: "pending-project-identity" | "resolved";
  storeRoot?: string;
  eventsPath?: string;
  projectId?: string;
  vaultId?: string;
  storeId?: string;
}

export type PendingProjectInitializationSummary = ProjectInitializationSummary & {
  routeState: "pending-project-identity";
  storeRoot?: never;
  eventsPath?: never;
  projectId?: never;
  vaultId?: never;
  storeId?: never;
};

export type RoutedProjectInitializationSummary = ProjectInitializationSummary & {
  routeState: "resolved";
  storeRoot: string;
  eventsPath: string;
  projectId: string;
  vaultId: string;
  storeId?: string;
};

export type InitializedProjectSummary = RoutedProjectInitializationSummary & {
  storeId: string;
};

export type ProjectInitializationInspection =
  | {
      state: "new-project";
      summary: PendingProjectInitializationSummary;
      remediation: ["rerun with --apply"];
    }
  | {
      state: "replica-decision-required";
      summary: RoutedProjectInitializationSummary;
      remediation: ["rerun with --replica initialize-local --apply"];
    }
  | {
      state: "recoverable-manifest";
      summary: InitializedProjectSummary;
      remediation: ["rerun with --apply"];
    }
  | {
      state: "initialized";
      summary: InitializedProjectSummary;
      remediation: [];
    }
  | {
      state: "blocked";
      code: string;
      message: string;
      summary: ProjectInitializationSummary;
      remediation: string[];
    };

export type OrchestratorAdminResult =
  | { action: "init-inspection"; inspection: ProjectInitializationInspection }
  | { action: "initialized"; result: ProjectStoreBootstrapResult }
  | {
      action: "status";
      projectId: string;
      vaultId: string;
      storeId: string;
      workspaceId: string;
      eventsPath: string;
      runtime: RuntimeCapabilityReport;
    }
  | { action: "integrity"; report: IntegrityReport };

export interface OrchestratorBindingService {
  establish(request: TrustedProjectBindingRequest): Promise<ProjectBindingResolution>;
  revalidate(binding: ProjectBinding): Promise<ProjectContext>;
}

export interface OrchestratorAdminExecutor {
  open(): Promise<unknown>;
  quickIntegrity(): Promise<IntegrityReport>;
  fullIntegrity(): Promise<IntegrityReport>;
  close(): Promise<void>;
}

export interface OrchestratorIntegrityRecorder {
  record(context: ProjectContext, report: IntegrityReport): Promise<void>;
}

export interface OrchestratorWorkspaceAuthority {
  descriptorPath: string;
  projectId: ProjectBinding["projectId"];
  vaultId: ProjectBinding["vaultId"];
  storeId: ProjectBinding["storeId"];
  workspaceId: ProjectBinding["workspaceId"];
  storeRoute: ProjectStoreRoute;
  workspace: WorkspaceSnapshot;
}

export interface OrchestratorAdminDependencies {
  runtimeProbe(): Promise<RuntimeCapabilityResult>;
  inspectInitialization(
    projectRoot: string,
    vaultRoot: string,
  ): Promise<ProjectInitializationInspection>;
  inspectWorkspaceAuthority(
    projectRoot: string,
    vaultRoot: string,
  ): Promise<OrchestratorWorkspaceAuthority>;
  bootstrap: ProjectStoreBootstrapService;
  bindingService: OrchestratorBindingService;
  executorFactory(context: ProjectContext): OrchestratorAdminExecutor;
  integrityRecorder: OrchestratorIntegrityRecorder;
  clientInstanceId(): string;
}

interface SafeFailure {
  ok: false;
  code: string;
  message: string;
  remediation?: string[];
  summary?: ProjectInitializationSummary;
}

const TRUSTED_SAFE_ADMIN_FAILURES = new WeakMap<SafeAdminError, SafeFailure>();

class SafeAdminError extends Error {
  constructor(failure: SafeFailure) {
    super(failure.code);
    TRUSTED_SAFE_ADMIN_FAILURES.set(this, failure);
    this.name = "SafeAdminError";
  }
}

function writeJson(writer: (text: string) => void, value: unknown, compact = false): void {
  writer(`${JSON.stringify(value, null, compact ? undefined : 2)}\n`);
}

function usageFailure(code: unknown): SafeFailure {
  const messages: Record<string, string> = {
    INVALID_COMMAND_LINE_INPUT: "Invalid command-line input",
    MISSING_VALUE_PROJECT_ROOT: "A value is required for --project-root",
    MISSING_VALUE_VAULT: "A value is required for --vault",
    MISSING_VALUE_REPLICA: "A value is required for --replica",
    REPLICA_DECISION_INVALID: "The --replica decision is invalid",
    PROJECT_ROOT_NOT_EXPLICIT: "A literal --project-root is required",
    VAULT_ROOT_NOT_EXPLICIT: "A literal --vault is required",
    PROJECT_ROOT_MISSING: "The explicit project root is unavailable",
    VAULT_ROOT_MISSING: "The explicit vault root is unavailable or outside the project root",
  };
  const safeCode = typeof code === "string" && Object.hasOwn(messages, code)
    ? code
    : "INVALID_COMMAND_LINE_INPUT";
  return {
    ok: false,
    code: safeCode,
    message: messages[safeCode],
  };
}

function isLiteralRoot(value: string | undefined): value is string {
  if (typeof value !== "string") return false;
  const root = value.trim();
  return root.length > 0 && root.toLowerCase() !== "dynamic" && root.toLowerCase() !== "auto";
}

function canonicalRoots(options: CliOptions): { projectRoot: string; vaultRoot: string } {
  if (!isLiteralRoot(options.projectRoot)) {
    throw new CliUsageError("PROJECT_ROOT_NOT_EXPLICIT");
  }
  if (!isLiteralRoot(options.vault)) {
    throw new CliUsageError("VAULT_ROOT_NOT_EXPLICIT");
  }

  let projectRoot: string;
  try {
    projectRoot = canonicalExistingDirectory(options.projectRoot.trim());
  } catch {
    throw new CliUsageError("PROJECT_ROOT_MISSING");
  }
  let vaultRoot: string;
  try {
    vaultRoot = canonicalExistingDirectory(options.vault.trim());
    assertContainedPath(projectRoot, vaultRoot);
  } catch {
    throw new CliUsageError("VAULT_ROOT_MISSING");
  }
  return { projectRoot, vaultRoot };
}

function trustedRequest(
  roots: { projectRoot: string; vaultRoot: string },
  actorRole: "maintenance" | "untrusted",
  dependencies: OrchestratorAdminDependencies,
): TrustedProjectBindingRequest {
  return parseTrustedProjectBindingRequest({
    source: "explicit-cli",
    projectRoot: roots.projectRoot,
    vaultRoot: roots.vaultRoot,
    clientNamespace: "memory-vault-cli",
    clientInstanceId: dependencies.clientInstanceId(),
    actorRole,
    generation: 1,
  });
}

function snapshotTrue(value: unknown): true {
  if (value !== true) throw new Error("ADMIN_SNAPSHOT_INVALID");
  return true;
}

function snapshotSafeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error("ADMIN_SNAPSHOT_INVALID");
  }
  return Number(value);
}

const VERSION_PATTERN = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
const RFC3339_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/;

function snapshotVersion(value: unknown): string {
  const version = snapshotString(value);
  if (!VERSION_PATTERN.test(version)) throw new Error("ADMIN_SNAPSHOT_INVALID");
  return version;
}

function snapshotRfc3339(value: unknown): string {
  const timestamp = snapshotString(value);
  const match = RFC3339_PATTERN.exec(timestamp);
  if (match === null) throw new Error("ADMIN_SNAPSHOT_INVALID");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === "Z" ? 0 : Number(match[10]);
  const offsetMinute = match[8] === "Z" ? 0 : Number(match[11]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    year < 1
    || month < 1
    || month > 12
    || day < 1
    || day > (monthDays[month - 1] ?? 0)
    || hour < 0
    || hour > 23
    || minute < 0
    || minute > 59
    || second < 0
    || second > 59
    || offsetHour < 0
    || offsetHour > 23
    || offsetMinute < 0
    || offsetMinute > 59
  ) {
    throw new Error("ADMIN_SNAPSHOT_INVALID");
  }
  return timestamp;
}

function runtimeSnapshot(result: unknown): RuntimeCapabilityReport {
  if (typeof result !== "object" || result === null) {
    throw new Error("ADMIN_SNAPSHOT_INVALID");
  }
  const ok = Reflect.get(result, "ok");
  if (ok === false) {
    throw new SafeAdminError({
      ok: false,
      code: "SQLITE_CAPABILITY_MISSING",
      message: "Required SQLite runtime capabilities are unavailable",
      remediation: ["run memory-vault diagnose and restore the required Node.js/SQLite runtime"],
    });
  }
  if (ok !== true) throw new Error("ADMIN_SNAPSHOT_INVALID");
  if (snapshotSafeInteger(Reflect.get(result, "busyTimeoutMs")) !== 5000) {
    throw new Error("ADMIN_SNAPSHOT_INVALID");
  }
  if (snapshotSafeInteger(Reflect.get(result, "applicationId")) !== 0x504d454d) {
    throw new Error("ADMIN_SNAPSHOT_INVALID");
  }
  const nodeVersion = snapshotVersion(Reflect.get(result, "nodeVersion"));
  const sqliteVersion = snapshotVersion(Reflect.get(result, "sqliteVersion"));
  if (
    compareVersions(nodeVersion, MINIMUM_NODE_VERSION) < 0
    || compareVersions(sqliteVersion, MINIMUM_SQLITE_VERSION) < 0
  ) {
    throw new Error("ADMIN_SNAPSHOT_INVALID");
  }
  return {
    nodeVersion,
    sqliteVersion,
    nodeVersionAtLeastMinimum: snapshotTrue(Reflect.get(result, "nodeVersionAtLeastMinimum")),
    sqliteVersionAtLeastMinimum: snapshotTrue(Reflect.get(result, "sqliteVersionAtLeastMinimum")),
    nodeSqlite: snapshotTrue(Reflect.get(result, "nodeSqlite")),
    wal: snapshotTrue(Reflect.get(result, "wal")),
    fts5: snapshotTrue(Reflect.get(result, "fts5")),
    foreignKeys: snapshotTrue(Reflect.get(result, "foreignKeys")),
    synchronousFull: snapshotTrue(Reflect.get(result, "synchronousFull")),
    busyTimeoutMs: 5000,
    trustedSchemaOff: snapshotTrue(Reflect.get(result, "trustedSchemaOff")),
    transactionRollback: snapshotTrue(Reflect.get(result, "transactionRollback")),
    applicationId: 0x504d454d,
  };
}

function snapshotRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("ADMIN_SNAPSHOT_INVALID");
  }
  return value as Record<string, unknown>;
}

function snapshotExactRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  const record = snapshotRecord(value);
  const expected = new Set(expectedKeys);
  const observed = Reflect.ownKeys(record);
  if (
    observed.length !== expected.size
    || observed.some((key) => typeof key !== "string" || !expected.has(key))
  ) {
    throw new Error("ADMIN_SNAPSHOT_INVALID");
  }
  return record;
}

function snapshotBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("ADMIN_SNAPSHOT_INVALID");
  return value;
}

function snapshotCanonicalAbsolutePath(value: unknown): string {
  const path = snapshotString(value);
  if (!isAbsolute(path)) throw new Error("ADMIN_SNAPSHOT_INVALID");
  const normalized = resolve(path);
  const sameShape = process.platform === "win32"
    ? path.toLowerCase() === normalized.toLowerCase()
    : path === normalized;
  if (!sameShape) throw new Error("ADMIN_SNAPSHOT_INVALID");
  return normalized;
}

function routeSnapshot(value: unknown): ProjectStoreRoute {
  const route = snapshotExactRecord(value, [
    "kind",
    "storeRoot",
    "eventsPath",
    "storeManifestPath",
    "projectionManifestPath",
  ]);
  const kind = Reflect.get(route, "kind");
  if (kind !== "git-common" && kind !== "vault-local") {
    throw new Error("ADMIN_SNAPSHOT_INVALID");
  }
  const storeRoot = snapshotCanonicalAbsolutePath(Reflect.get(route, "storeRoot"));
  const eventsPath = snapshotCanonicalAbsolutePath(Reflect.get(route, "eventsPath"));
  const storeManifestPath = snapshotCanonicalAbsolutePath(
    Reflect.get(route, "storeManifestPath"),
  );
  const projectionManifestPath = snapshotCanonicalAbsolutePath(
    Reflect.get(route, "projectionManifestPath"),
  );
  if (
    !sameNativePath(eventsPath, join(storeRoot, "events.sqlite"))
    || !sameNativePath(storeManifestPath, join(storeRoot, "store-manifest.json"))
    || !sameNativePath(projectionManifestPath, join(storeRoot, "current-projection.json"))
  ) {
    throw new Error("ADMIN_SNAPSHOT_INVALID");
  }
  return {
    kind,
    storeRoot,
    eventsPath,
    storeManifestPath,
    projectionManifestPath,
  };
}

const HEAD_COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function validBranchRef(value: string): boolean {
  const components = value.split("/");
  return value.startsWith("refs/")
    && !value.endsWith(".")
    && !value.endsWith("/")
    && !value.includes("..")
    && !value.includes("@{")
    && !value.includes("//")
    && !/[\u0000-\u0020\u007f~^:?*\[\\]/.test(value)
    && components.every((component) => component.length > 0
      && !component.startsWith(".")
      && !component.endsWith(".lock"));
}

function workspaceSnapshot(
  value: unknown,
  projectId: ProjectBinding["projectId"],
  vaultId: ProjectBinding["vaultId"],
  projectRoot: string,
  expectedWorkspaceId: ProjectBinding["workspaceId"],
): WorkspaceSnapshot {
  const observed = snapshotRecord(value);
  const kind = Reflect.get(observed, "kind");
  if (kind === "non-git") {
    const workspace = snapshotExactRecord(value, ["kind", "workspaceRoot", "workspaceId"]);
    const workspaceRoot = snapshotCanonicalAbsolutePath(Reflect.get(workspace, "workspaceRoot"));
    const workspaceId = snapshotString(
      Reflect.get(workspace, "workspaceId"),
    ) as ProjectBinding["workspaceId"];
    if (
      !sameNativePath(workspaceRoot, projectRoot)
      || workspaceId !== expectedWorkspaceId
      || workspaceId !== deriveNonGitWorkspaceId(projectId, vaultId)
    ) {
      throw new Error("ADMIN_SNAPSHOT_INVALID");
    }
    return { kind: "non-git", workspaceRoot, workspaceId };
  }
  if (kind !== "git") throw new Error("ADMIN_SNAPSHOT_INVALID");

  const workspace = snapshotExactRecord(value, [
    "kind",
    "worktreeRoot",
    "gitDir",
    "gitCommonDir",
    "headCommit",
    "branchRef",
    "detached",
    "workspaceId",
  ]);
  const worktreeRoot = snapshotCanonicalAbsolutePath(Reflect.get(workspace, "worktreeRoot"));
  const gitDir = snapshotCanonicalAbsolutePath(Reflect.get(workspace, "gitDir"));
  const gitCommonDir = snapshotCanonicalAbsolutePath(Reflect.get(workspace, "gitCommonDir"));
  const headCommit = snapshotString(Reflect.get(workspace, "headCommit"));
  const detached = snapshotBoolean(Reflect.get(workspace, "detached"));
  const branchValue = Reflect.get(workspace, "branchRef");
  const branchRef = branchValue === null ? null : snapshotString(branchValue);
  const workspaceId = snapshotString(
    Reflect.get(workspace, "workspaceId"),
  ) as ProjectBinding["workspaceId"];
  let derivedWorkspaceId: ProjectBinding["workspaceId"];
  try {
    assertContainedPath(worktreeRoot, projectRoot);
    derivedWorkspaceId = deriveGitWorkspaceId(projectId, gitCommonDir, gitDir);
  } catch {
    throw new Error("ADMIN_SNAPSHOT_INVALID");
  }
  if (
    !HEAD_COMMIT_PATTERN.test(headCommit)
    || (detached ? branchRef !== null : branchRef === null || !validBranchRef(branchRef))
    || workspaceId !== expectedWorkspaceId
    || workspaceId !== derivedWorkspaceId
  ) {
    throw new Error("ADMIN_SNAPSHOT_INVALID");
  }
  return {
    kind: "git",
    worktreeRoot,
    gitDir,
    gitCommonDir,
    headCommit,
    branchRef,
    detached,
    workspaceId,
  };
}

function validatedBindingSnapshot(
  value: unknown,
  request: TrustedProjectBindingRequest,
): ProjectBinding {
  const binding = snapshotExactRecord(value, [
    "projectBindingId",
    "generation",
    "contextFingerprint",
    "source",
    "projectId",
    "vaultId",
    "storeId",
    "workspaceId",
    "clientNamespace",
    "clientInstanceId",
    "actorRole",
    "projectRoot",
    "vaultRoot",
    "descriptorPath",
    "storeRoute",
    "workspace",
    "establishedAt",
  ]);
  const projectBindingId = snapshotUuid(Reflect.get(binding, "projectBindingId"));
  const generation = snapshotSafeInteger(Reflect.get(binding, "generation"));
  const contextFingerprint = snapshotHash(Reflect.get(binding, "contextFingerprint"));
  const projectId = snapshotUuid(
    Reflect.get(binding, "projectId"),
  ) as ProjectBinding["projectId"];
  const vaultId = snapshotUuid(
    Reflect.get(binding, "vaultId"),
  ) as ProjectBinding["vaultId"];
  const storeId = snapshotUuid(
    Reflect.get(binding, "storeId"),
  ) as ProjectBinding["storeId"];
  const workspaceId = snapshotString(
    Reflect.get(binding, "workspaceId"),
  ) as ProjectBinding["workspaceId"];
  const projectRoot = snapshotCanonicalAbsolutePath(Reflect.get(binding, "projectRoot"));
  const vaultRoot = snapshotCanonicalAbsolutePath(Reflect.get(binding, "vaultRoot"));
  const descriptorPath = snapshotCanonicalAbsolutePath(Reflect.get(binding, "descriptorPath"));
  if (
    generation !== request.generation
    || Reflect.get(binding, "source") !== request.source
    || Reflect.get(binding, "actorRole") !== request.actorRole
    || Reflect.get(binding, "clientNamespace") !== request.clientNamespace
    || Reflect.get(binding, "clientInstanceId") !== request.clientInstanceId
    || !sameNativePath(projectRoot, request.projectRoot)
    || !sameNativePath(vaultRoot, request.vaultRoot)
    || !sameNativePath(descriptorPath, join(vaultRoot, ".memory-mcp", "project-identity.json"))
  ) {
    throw new Error("ADMIN_SNAPSHOT_INVALID");
  }

  const workspace = workspaceSnapshot(
    Reflect.get(binding, "workspace"),
    projectId,
    vaultId,
    projectRoot,
    workspaceId,
  );
  const storeRoute = routeSnapshot(Reflect.get(binding, "storeRoute"));
  const expectedStoreRoot = workspace.kind === "git"
    ? resolve(workspace.gitCommonDir, "project-memory", projectId, "v2")
    : resolve(vaultRoot, ".memory-mcp", "v2");
  if (
    storeRoute.kind !== (workspace.kind === "git" ? "git-common" : "vault-local")
    || !sameNativePath(storeRoute.storeRoot, expectedStoreRoot)
  ) {
    throw new Error("ADMIN_SNAPSHOT_INVALID");
  }

  const authority = {
    generation,
    source: request.source,
    projectId,
    vaultId,
    storeId,
    workspaceId,
    clientNamespace: request.clientNamespace,
    clientInstanceId: request.clientInstanceId,
    actorRole: request.actorRole,
    projectRoot,
    vaultRoot,
    descriptorPath,
    storeRoute,
    workspace,
  };
  if (computeProjectContextFingerprint(authority) !== contextFingerprint) {
    throw new Error("ADMIN_SNAPSHOT_INVALID");
  }
  return {
    ...authority,
    projectBindingId,
    contextFingerprint,
    establishedAt: snapshotRfc3339(Reflect.get(binding, "establishedAt")),
  };
}

function workspaceAuthoritySnapshot(
  value: unknown,
  request: TrustedProjectBindingRequest,
): OrchestratorWorkspaceAuthority {
  const authority = snapshotExactRecord(value, [
    "descriptorPath",
    "projectId",
    "vaultId",
    "storeId",
    "workspaceId",
    "storeRoute",
    "workspace",
  ]);
  const descriptorPath = snapshotCanonicalAbsolutePath(
    Reflect.get(authority, "descriptorPath"),
  );
  const projectId = snapshotUuid(
    Reflect.get(authority, "projectId"),
  ) as ProjectBinding["projectId"];
  const vaultId = snapshotUuid(
    Reflect.get(authority, "vaultId"),
  ) as ProjectBinding["vaultId"];
  const storeId = snapshotUuid(
    Reflect.get(authority, "storeId"),
  ) as ProjectBinding["storeId"];
  const workspaceId = snapshotString(
    Reflect.get(authority, "workspaceId"),
  ) as ProjectBinding["workspaceId"];
  if (!sameNativePath(
    descriptorPath,
    join(request.vaultRoot, ".memory-mcp", "project-identity.json"),
  )) {
    throw new Error("ADMIN_SNAPSHOT_INVALID");
  }
  const workspace = workspaceSnapshot(
    Reflect.get(authority, "workspace"),
    projectId,
    vaultId,
    request.projectRoot,
    workspaceId,
  );
  const storeRoute = routeSnapshot(Reflect.get(authority, "storeRoute"));
  const expectedStoreRoot = workspace.kind === "git"
    ? resolve(workspace.gitCommonDir, "project-memory", projectId, "v2")
    : resolve(request.vaultRoot, ".memory-mcp", "v2");
  if (
    storeRoute.kind !== (workspace.kind === "git" ? "git-common" : "vault-local")
    || !sameNativePath(storeRoute.storeRoot, expectedStoreRoot)
  ) {
    throw new Error("ADMIN_SNAPSHOT_INVALID");
  }
  return {
    descriptorPath,
    projectId,
    vaultId,
    storeId,
    workspaceId,
    storeRoute,
    workspace,
  };
}

function assertObservedWorkspaceAuthority(
  binding: ProjectBinding,
  observed: OrchestratorWorkspaceAuthority,
): void {
  if (
    binding.projectId !== observed.projectId
    || binding.vaultId !== observed.vaultId
    || binding.storeId !== observed.storeId
    || binding.workspaceId !== observed.workspaceId
    || !sameNativePath(binding.descriptorPath, observed.descriptorPath)
    || canonicalJson(binding.storeRoute) !== canonicalJson(observed.storeRoute)
    || canonicalJson(binding.workspace) !== canonicalJson(observed.workspace)
  ) {
    throw new Error("ADMIN_SNAPSHOT_INVALID");
  }
}

async function verifyObservedWorkspaceAuthority(
  binding: ProjectBinding,
  request: TrustedProjectBindingRequest,
  dependencies: OrchestratorAdminDependencies,
): Promise<void> {
  const observed = workspaceAuthoritySnapshot(
    await dependencies.inspectWorkspaceAuthority(request.projectRoot, request.vaultRoot),
    request,
  );
  assertObservedWorkspaceAuthority(binding, observed);
}

function validatedContextSnapshot(
  value: unknown,
  established: ProjectBinding,
  request: TrustedProjectBindingRequest,
): ProjectContext {
  const observed = snapshotRecord(value);
  const hasBranchScope = Object.hasOwn(observed, "branchScopeId");
  const context = snapshotExactRecord(value, hasBranchScope
    ? ["binding", "workspace", "branchScopeId", "checkedAt"]
    : ["binding", "workspace", "checkedAt"]);
  const binding = validatedBindingSnapshot(Reflect.get(context, "binding"), request);
  if (canonicalJson(binding) !== canonicalJson(established)) {
    throw new Error("ADMIN_SNAPSHOT_INVALID");
  }
  const workspace = workspaceSnapshot(
    Reflect.get(context, "workspace"),
    binding.projectId,
    binding.vaultId,
    binding.projectRoot,
    binding.workspaceId,
  );
  if (canonicalJson(workspace) !== canonicalJson(binding.workspace)) {
    throw new Error("ADMIN_SNAPSHOT_INVALID");
  }
  const branchScopeId = hasBranchScope
    ? snapshotUuid(Reflect.get(context, "branchScopeId")) as NonNullable<ProjectContext["branchScopeId"]>
    : undefined;
  return {
    binding,
    workspace,
    ...(branchScopeId === undefined ? {} : { branchScopeId }),
    checkedAt: snapshotRfc3339(Reflect.get(context, "checkedAt")),
  };
}

function bootstrapSnapshot(value: unknown): ProjectStoreBootstrapResult {
  const result = snapshotRecord(value);
  const descriptorSource = snapshotRecord(Reflect.get(result, "descriptor"));
  const descriptor = parseProjectDescriptor({
    schemaVersion: Reflect.get(descriptorSource, "schemaVersion"),
    projectId: snapshotUuid(Reflect.get(descriptorSource, "projectId")),
    vaultId: snapshotUuid(Reflect.get(descriptorSource, "vaultId")),
    createdAt: snapshotString(Reflect.get(descriptorSource, "createdAt")),
  });

  const manifestSource = snapshotRecord(Reflect.get(result, "manifest"));
  const integritySource = snapshotRecord(Reflect.get(manifestSource, "lastIntegrity"));
  const integrityStatus = Reflect.get(integritySource, "status");
  const lastIntegrity = integrityStatus === "never"
    ? { status: "never" as const }
    : integrityStatus === "passed" || integrityStatus === "failed"
      ? {
          status: integrityStatus,
          checkedAt: snapshotString(Reflect.get(integritySource, "checkedAt")),
          schemaFingerprint: snapshotHash(Reflect.get(integritySource, "schemaFingerprint")),
          terminalEventHash: snapshotHash(Reflect.get(integritySource, "terminalEventHash")),
        }
      : (() => { throw new Error("ADMIN_SNAPSHOT_INVALID"); })();
  const manifest = parseStoreManifest({
    schemaVersion: Reflect.get(manifestSource, "schemaVersion"),
    storeId: snapshotUuid(Reflect.get(manifestSource, "storeId")),
    projectId: snapshotUuid(Reflect.get(manifestSource, "projectId")),
    vaultId: snapshotUuid(Reflect.get(manifestSource, "vaultId")),
    createdAt: snapshotString(Reflect.get(manifestSource, "createdAt")),
    lastIntegrity,
  });
  if (
    manifest.projectId !== descriptor.projectId
    || manifest.vaultId !== descriptor.vaultId
  ) {
    throw new Error("ADMIN_SNAPSHOT_INVALID");
  }
  return {
    descriptor,
    manifest,
    route: routeSnapshot(Reflect.get(result, "route")),
    createdDescriptor: snapshotBoolean(Reflect.get(result, "createdDescriptor")),
    createdStore: snapshotBoolean(Reflect.get(result, "createdStore")),
    recoveredManifest: snapshotBoolean(Reflect.get(result, "recoveredManifest")),
  };
}

function assertBootstrapAuthority(
  result: ProjectStoreBootstrapResult,
  binding: ProjectBinding,
): void {
  if (
    result.descriptor.projectId !== binding.projectId
    || result.descriptor.vaultId !== binding.vaultId
    || result.manifest.projectId !== binding.projectId
    || result.manifest.vaultId !== binding.vaultId
    || result.manifest.storeId !== binding.storeId
    || canonicalJson(result.route) !== canonicalJson(binding.storeRoute)
  ) {
    throw new Error("ADMIN_SNAPSHOT_INVALID");
  }
}

function statusSnapshot(
  bindingValue: unknown,
  runtime: RuntimeCapabilityReport,
  request: TrustedProjectBindingRequest,
): unknown {
  const binding = validatedBindingSnapshot(bindingValue, request);
  return {
    action: "status",
    projectId: binding.projectId,
    vaultId: binding.vaultId,
    storeId: binding.storeId,
    workspaceId: binding.workspaceId,
    eventsPath: binding.storeRoute.eventsPath,
    runtime,
  };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_PATTERN = /^[0-9a-f]{64}$/;

function snapshotString(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("ADMIN_SNAPSHOT_INVALID");
  }
  return value;
}

function snapshotUuid(value: unknown): string {
  const id = snapshotString(value);
  if (!UUID_PATTERN.test(id)) throw new Error("ADMIN_SNAPSHOT_INVALID");
  return id;
}

function snapshotHash(value: unknown): string {
  const hash = snapshotString(value);
  if (!HASH_PATTERN.test(hash)) throw new Error("ADMIN_SNAPSHOT_INVALID");
  return hash;
}

function snapshotAbsolutePath(value: unknown): string {
  const path = snapshotString(value);
  if (!isAbsolute(path)) throw new Error("ADMIN_SNAPSHOT_INVALID");
  return resolve(path);
}

function summarySnapshot(
  summary: unknown,
  expectedRoots?: { projectRoot: string; vaultRoot: string },
): ProjectInitializationSummary {
  if (typeof summary !== "object" || summary === null) {
    throw new Error("ADMIN_SNAPSHOT_INVALID");
  }
  const routeState = Reflect.get(summary, "routeState");
  const projectRoot = snapshotAbsolutePath(Reflect.get(summary, "projectRoot"));
  const vaultRoot = snapshotAbsolutePath(Reflect.get(summary, "vaultRoot"));
  assertContainedPath(projectRoot, vaultRoot);
  if (
    expectedRoots !== undefined
    && (
      !sameNativePath(projectRoot, expectedRoots.projectRoot)
      || !sameNativePath(vaultRoot, expectedRoots.vaultRoot)
    )
  ) {
    throw new Error("ADMIN_SNAPSHOT_INVALID");
  }
  if (routeState === "pending-project-identity") {
    return {
      projectRoot,
      vaultRoot,
      routeState: "pending-project-identity",
    };
  }
  if (routeState !== "resolved") throw new Error("ADMIN_SNAPSHOT_INVALID");
  const storeRoot = snapshotAbsolutePath(Reflect.get(summary, "storeRoot"));
  const eventsPath = snapshotAbsolutePath(Reflect.get(summary, "eventsPath"));
  assertContainedPath(storeRoot, eventsPath);
  if (!sameNativePath(eventsPath, join(storeRoot, "events.sqlite"))) {
    throw new Error("ADMIN_SNAPSHOT_INVALID");
  }
  const storeIdValue = Reflect.get(summary, "storeId");
  return {
    projectRoot,
    vaultRoot,
    routeState: "resolved",
    storeRoot,
    eventsPath,
    projectId: snapshotUuid(Reflect.get(summary, "projectId")),
    vaultId: snapshotUuid(Reflect.get(summary, "vaultId")),
    ...(storeIdValue === undefined ? {} : { storeId: snapshotUuid(storeIdValue) }),
  };
}

function inspectionSnapshot(
  inspection: unknown,
  expectedRoots: { projectRoot: string; vaultRoot: string },
): ProjectInitializationInspection {
  if (typeof inspection !== "object" || inspection === null) {
    throw new Error("ADMIN_SNAPSHOT_INVALID");
  }
  const state = Reflect.get(inspection, "state");
  const summary = summarySnapshot(Reflect.get(inspection, "summary"), expectedRoots);
  switch (state) {
    case "new-project":
      if (summary.routeState !== "pending-project-identity") {
        throw new Error("ADMIN_SNAPSHOT_INVALID");
      }
      return {
        state: "new-project",
        summary: summary as PendingProjectInitializationSummary,
        remediation: ["rerun with --apply"],
      };
    case "replica-decision-required":
      if (summary.routeState !== "resolved") throw new Error("ADMIN_SNAPSHOT_INVALID");
      return {
        state: "replica-decision-required",
        summary: summary as RoutedProjectInitializationSummary,
        remediation: ["rerun with --replica initialize-local --apply"],
      };
    case "recoverable-manifest":
      if (summary.routeState !== "resolved" || summary.storeId === undefined) {
        throw new Error("ADMIN_SNAPSHOT_INVALID");
      }
      return {
        state: "recoverable-manifest",
        summary: summary as InitializedProjectSummary,
        remediation: ["rerun with --apply"],
      };
    case "initialized":
      if (summary.routeState !== "resolved" || summary.storeId === undefined) {
        throw new Error("ADMIN_SNAPSHOT_INVALID");
      }
      return {
        state: "initialized",
        summary: summary as InitializedProjectSummary,
        remediation: [],
      };
    case "blocked":
      const description = describeProjectBindingFailure(Reflect.get(inspection, "code"));
      return {
        state: "blocked",
        code: description.code,
        message: description.message,
        summary,
        remediation: description.remediation,
      };
    default:
      throw new Error("ADMIN_SNAPSHOT_INVALID");
  }
}

function integritySnapshot(report: IntegrityReport): IntegrityReport {
  return {
    ok: report.ok,
    mode: report.mode,
    projectId: report.projectId,
    storeId: report.storeId,
    firstGlobalPosition: report.firstGlobalPosition,
    lastGlobalPosition: report.lastGlobalPosition,
    eventsVerified: report.eventsVerified,
    streamsVerified: report.streamsVerified,
    commandsVerified: report.commandsVerified,
    schemaFingerprint: report.schemaFingerprint,
    terminalEventHash: report.terminalEventHash,
    issues: report.issues.map((issue) => ({
      code: issue.code,
      message: issue.message,
      ...(issue.globalPosition === undefined ? {} : { globalPosition: issue.globalPosition }),
      ...(issue.streamId === undefined ? {} : { streamId: issue.streamId }),
      ...(issue.commandId === undefined ? {} : { commandId: issue.commandId }),
    })),
  };
}

function validatedIntegrityReport(
  value: unknown,
  context: ProjectContext,
  fullIntegrity: boolean,
): IntegrityReport {
  let report: IntegrityReport;
  try {
    report = decodeIntegrityReport(value);
  } catch {
    throw new SafeAdminError({
      ok: false,
      code: "INTEGRITY_REPORT_INVALID",
      message: "Integrity report is invalid for this request",
    });
  }
  if (report.projectId !== context.binding.projectId) {
    throw new ProjectBindingError("PROJECT_ID_MISMATCH");
  }
  if (report.storeId !== context.binding.storeId) {
    throw new ProjectBindingError("STORE_ID_MISMATCH");
  }
  const expectedMode = fullIntegrity ? "full" : "quick";
  if (
    report.mode !== expectedMode
    || report.ok !== (report.issues.length === 0)
  ) {
    throw new SafeAdminError({
      ok: false,
      code: "INTEGRITY_REPORT_INVALID",
      message: "Integrity report is invalid for this request",
    });
  }
  return report;
}

function bindingFailure(resolution: Exclude<ProjectBindingResolution, { ok: true }>): SafeAdminError {
  const description = describeProjectBindingFailure(resolution.code);
  return new SafeAdminError({ ok: false, ...description });
}

type ClassifiedError =
  | { kind: "safe"; failure: unknown }
  | { kind: "usage" | "binding" | "bootstrap" | "worker"; code: unknown }
  | { kind: "unknown" };

const UNKNOWN_ADMIN_FAILURE: SafeFailure = {
  ok: false,
  code: "ORCHESTRATOR_ADMIN_FAILED",
  message: "Orchestrator administration failed",
};

interface ClassifiedFailure {
  failure: SafeFailure;
  exitCode: 1 | 2;
}

function classifyError(error: unknown): ClassifiedError {
  try {
    if (error instanceof SafeAdminError) {
      return { kind: "safe", failure: TRUSTED_SAFE_ADMIN_FAILURES.get(error) };
    }
    if (error instanceof CliUsageError) {
      return { kind: "usage", code: Reflect.get(error, "code") };
    }
    if (error instanceof ProjectBindingError) {
      return { kind: "binding", code: Reflect.get(error, "code") };
    }
    if (error instanceof ProjectStoreWorkerError) {
      return { kind: "worker", code: Reflect.get(error, "code") };
    }
    if (typeof error === "object" && error !== null) {
      const name = Reflect.get(error, "name");
      if (name === "ProjectStoreBootstrapError") {
        return { kind: "bootstrap", code: Reflect.get(error, "code") };
      }
    }
  } catch {
    return { kind: "unknown" };
  }
  return { kind: "unknown" };
}

function safeAdminFailureSnapshot(value: unknown): SafeFailure {
  if (typeof value !== "object" || value === null) return UNKNOWN_ADMIN_FAILURE;
  const code = Reflect.get(value, "code");
  if (code === "SQLITE_CAPABILITY_MISSING") {
    return {
      ok: false,
      code,
      message: "Required SQLite runtime capabilities are unavailable",
      remediation: ["run memory-vault diagnose and restore the required Node.js/SQLite runtime"],
    };
  }
  if (code === "INTEGRITY_REPORT_INVALID") {
    return {
      ok: false,
      code,
      message: "Integrity report is invalid for this request",
    };
  }
  if (typeof code !== "string") return UNKNOWN_ADMIN_FAILURE;
  const description = describeProjectBindingFailure(code);
  if (description.code !== code) return UNKNOWN_ADMIN_FAILURE;
  const summary = Reflect.get(value, "summary");
  return {
    ok: false,
    code: description.code,
    message: description.message,
    remediation: description.remediation,
    ...(summary === undefined
      ? {}
      : { summary: summarySnapshot(summary) }),
  };
}

function typedFailure(error: unknown): ClassifiedFailure {
  try {
    const classified = classifyError(error);
    if (classified.kind === "safe") {
      return { failure: safeAdminFailureSnapshot(classified.failure), exitCode: 1 };
    }
    if (classified.kind === "usage") {
      return {
        failure: usageFailure(classified.code),
        exitCode: 2,
      };
    }
    if (classified.kind === "binding") {
      return {
        failure: { ok: false, ...describeProjectBindingFailure(classified.code) },
        exitCode: 1,
      };
    }
    if (classified.kind === "bootstrap") {
    const descriptions: Record<string, Omit<SafeFailure, "ok" | "code">> = {
      PROJECT_REPLICA_DECISION_REQUIRED: {
        message: "This project clone requires an explicit replica decision",
        remediation: ["rerun with --replica initialize-local --apply"],
      },
      SCHEMA_TOO_NEW: {
        message: "The project store schema is newer than this CLI supports",
        remediation: ["upgrade the project-memory CLI before retrying"],
      },
      SQLITE_CAPABILITY_MISSING: {
        message: "Required SQLite runtime capabilities are unavailable",
      },
      STORE_UNAVAILABLE: {
        message: "The authoritative project store is unavailable or failed identity validation",
      },
    };
      const code = classified.code;
      const safeCode = typeof code === "string" && Object.hasOwn(descriptions, code)
      ? code
      : "STORE_UNAVAILABLE";
      return {
        failure: {
          ok: false,
          code: safeCode,
          ...(descriptions[safeCode] ?? { message: "Project-store initialization failed" }),
        },
        exitCode: 1,
      };
    }
    if (classified.kind === "worker") {
      const allowedCodes = new Set([
        "PROJECT_ID_MISMATCH",
        "VAULT_ID_MISMATCH",
        "STORE_ID_MISMATCH",
        "STORE_UNAVAILABLE",
        "WORKER_UNAVAILABLE",
        "WORKER_TIMEOUT",
        "WORKER_PROTOCOL_ERROR",
        "SQLITE_INTEGRITY_FAILED",
      ]);
      const code = classified.code;
      return {
        failure: {
          ok: false,
          code: typeof code === "string" && allowedCodes.has(code) ? code : "STORE_UNAVAILABLE",
          message: "The project-store worker could not complete the administration request",
        },
        exitCode: 1,
      };
    }
  } catch {
    return { failure: UNKNOWN_ADMIN_FAILURE, exitCode: 1 };
  }
  return { failure: UNKNOWN_ADMIN_FAILURE, exitCode: 1 };
}

async function runLegacyCommand(options: CliOptions, io: CliIo): Promise<0 | 1 | 2> {
  if (options.command === "help") {
    io.stdout(HELP);
    return 0;
  }

  if (options.command === "diagnose") {
    io.stdout(`${JSON.stringify(diagnoseMemoryConfig(process.env, process.cwd()), null, 2)}\n`);
    return 0;
  }

  const VALID_FORMATS = ["text", "json", "markdown"];
  if (!VALID_FORMATS.includes(options.format)) {
    io.stderr(`Invalid --format '${options.format}'. Use one of: ${VALID_FORMATS.join(", ")}.\n`);
    return 2;
  }
  if (
    !options.backup
    && !options.dryRun
    && (options.command === "fix" || options.command === "migrate")
  ) {
    io.stderr("Warning: --no-backup is ignored; a timestamped backup is always taken before writing.\n");
  }

  const vaultRoot = options.vault ?? loadMemoryConfig().vaultRoot;
  const vault = new VaultService(vaultRoot);
  const config = loadFrontmatterConfig(vaultRoot);
  const service = new FrontmatterService(vault, config.schema, config.sources, config.policy);
  const paths = options.paths.length ? options.paths : undefined;

  switch (options.command) {
    case "validate":
    case "report": {
      const summary = await service.validate(paths);
      io.stdout(`${service.report(summary, options.format)}\n`);
      return summary.counts.error || summary.counts.critical ? 1 : 0;
    }
    case "fix": {
      const result = await service.fix({
        paths,
        dryRun: options.dryRun,
        backup: options.backup,
        unsafe: options.unsafe,
        confirm: options.confirm,
      });
      io.stdout(`${JSON.stringify(result, null, 2)}\n`);
      if (result.requiresConfirm) {
        io.stderr("Note: --unsafe requires --confirm; only safe fixes were applied.\n");
      }
      return result.manual > 0 ? 1 : 0;
    }
    case "migrate": {
      if (options.rollback) {
        const result = await service.rollback({ dryRun: options.dryRun });
        io.stdout(`${JSON.stringify(result, null, 2)}\n`);
        return 0;
      }
      const result = await service.migrate({
        paths,
        dryRun: options.dryRun,
        backup: options.backup,
      });
      io.stdout(`${service.reportMigrate(result, options.format === "json" ? "json" : "text")}\n`);
      return result.manual > 0 ? 1 : 0;
    }
    case "init": {
      const path = projectConfigPath(vaultRoot);
      const schemaPath = projectConfigSchemaPath(vaultRoot);
      mkdirSync(dirname(path), { recursive: true });
      if (existsSync(path)) {
        io.stdout(`Project frontmatter config already exists: ${path}\n`);
      } else {
        writeFileSync(path, sampleProjectConfig(), "utf8");
        io.stdout(`Created project frontmatter config: ${path}\n`);
      }
      if (existsSync(schemaPath)) {
        io.stdout(`Project frontmatter config schema already exists: ${schemaPath}\n`);
      } else {
        writeFileSync(schemaPath, sampleProjectConfigSchema(), "utf8");
        io.stdout(`Created project frontmatter config schema: ${schemaPath}\n`);
      }
      return 0;
    }
    default:
      io.stdout(HELP);
      return 2;
  }
}

const V2_COMMANDS = new Set([
  "orchestrator-init",
  "orchestrator-status",
  "orchestrator-integrity",
]);

export async function runCliCommand(
  options: CliOptions,
  io: CliIo,
  dependencies: OrchestratorAdminDependencies,
): Promise<0 | 1 | 2> {
  if (!V2_COMMANDS.has(options.command)) return runLegacyCommand(options, io);

  try {
    const roots = canonicalRoots(options);
    const actorRole = options.command === "orchestrator-status" ? "untrusted" : "maintenance";
    const request = trustedRequest(roots, actorRole, dependencies);
    const runtime = runtimeSnapshot(await dependencies.runtimeProbe());

    if (options.command === "orchestrator-init") {
      if (options.dryRun) {
        const inspection = inspectionSnapshot(
          await dependencies.inspectInitialization(roots.projectRoot, roots.vaultRoot),
          roots,
        );
        if (inspection.state === "blocked") {
          throw new SafeAdminError({
            ok: false,
            code: inspection.code,
            message: inspection.message,
            remediation: [...inspection.remediation],
            summary: summarySnapshot(inspection.summary, roots),
          });
        }
        writeJson(io.stdout, { action: "init-inspection", inspection });
        return 0;
      }
      const result = bootstrapSnapshot(await dependencies.bootstrap.initialize({
        projectRoot: request.projectRoot,
        vaultRoot: request.vaultRoot,
        ...(options.replicaDecision === undefined
          ? {}
          : { replicaDecision: options.replicaDecision }),
      }));
      const bootstrapResolution = await dependencies.bindingService.establish(request);
      if (!bootstrapResolution.ok) throw bindingFailure(bootstrapResolution);
      const established = validatedBindingSnapshot(bootstrapResolution.binding, request);
      await verifyObservedWorkspaceAuthority(established, request, dependencies);
      const context = validatedContextSnapshot(
        await dependencies.bindingService.revalidate(established),
        established,
        request,
      );
      assertBootstrapAuthority(result, context.binding);
      writeJson(io.stdout, { action: "initialized", result });
      return 0;
    }

    const resolution = await dependencies.bindingService.establish(request);
    if (!resolution.ok) throw bindingFailure(resolution);
    const established = validatedBindingSnapshot(resolution.binding, request);
    await verifyObservedWorkspaceAuthority(established, request, dependencies);

    if (options.command === "orchestrator-status") {
      writeJson(io.stdout, statusSnapshot(established, runtime, request));
      return 0;
    }

    const context = validatedContextSnapshot(
      await dependencies.bindingService.revalidate(established),
      established,
      request,
    );
    const executor = dependencies.executorFactory(context);
    let untrustedReport: unknown;
    try {
      await executor.open();
      untrustedReport = options.fullIntegrity
        ? await executor.fullIntegrity()
        : await executor.quickIntegrity();
    } finally {
      await executor.close();
    }
    const report = validatedIntegrityReport(untrustedReport, context, options.fullIntegrity);
    let recordingFailed = false;
    try {
      await dependencies.integrityRecorder.record(context, report);
    } catch {
      recordingFailed = true;
    }
    writeJson(io.stdout, { action: "integrity", report: integritySnapshot(report) });
    if (recordingFailed) {
      writeJson(io.stderr, {
        ok: false,
        code: "INTEGRITY_RECORDING_FAILED",
        message: "Integrity completed but its manifest record could not be persisted",
      }, true);
      return 1;
    }
    return report.ok ? 0 : 1;
  } catch (error) {
    const classified = typedFailure(error);
    writeJson(io.stderr, classified.failure, true);
    return classified.exitCode;
  }
}

interface InitializationInspectorDependencies {
  descriptorRepository: ProjectDescriptorRepository;
  workspaceResolver: GitWorkspaceResolver;
  router: ProjectStoreRouter;
  manifestRepository: StoreManifestRepository;
  identityProbe: ProjectStoreIdentityProbe;
  pathExists(path: string): boolean;
}

interface StoreFileSignature {
  exists: boolean;
  stable: boolean;
  size?: bigint;
  modified?: bigint;
  changed?: bigint;
  fileId?: bigint;
  digest?: string;
}

const MAXIMUM_STABLE_SNAPSHOT_ATTEMPTS = 3;

function caughtErrorCode(error: unknown): string | undefined {
  try {
    if (typeof error !== "object" || error === null) return undefined;
    const code = Reflect.get(error, "code");
    return typeof code === "string" ? code : undefined;
  } catch {
    return undefined;
  }
}

function sameNativePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function validateCanonicalRegularSourceFile(path: string, optional: boolean): void {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (optional && caughtErrorCode(error) === "ENOENT") return;
    throw error;
  }
  if (!stat.isFile()) throw new Error("STORE_SNAPSHOT_FILE_NOT_REGULAR");
  const requested = resolve(path);
  const canonical = resolve(realpathSync.native(requested));
  if (!sameNativePath(requested, canonical)) {
    throw new Error("STORE_SNAPSHOT_FILE_NOT_CANONICAL");
  }
}

function validateCanonicalStoreSource(route: ProjectStoreRoute): void {
  const requestedRoot = resolve(route.storeRoot);
  const rootStat = lstatSync(requestedRoot);
  if (!rootStat.isDirectory()) throw new Error("STORE_SNAPSHOT_ROOT_NOT_CANONICAL");
  const canonicalRoot = resolve(realpathSync.native(requestedRoot));
  if (!sameNativePath(requestedRoot, canonicalRoot)) {
    throw new Error("STORE_SNAPSHOT_ROOT_NOT_CANONICAL");
  }

  const requestedEvents = resolve(route.eventsPath);
  if (!sameNativePath(requestedEvents, join(requestedRoot, "events.sqlite"))) {
    throw new Error("STORE_SNAPSHOT_ROUTE_INVALID");
  }
  validateCanonicalRegularSourceFile(requestedEvents, false);
  validateCanonicalRegularSourceFile(`${requestedEvents}-wal`, true);
  validateCanonicalRegularSourceFile(`${requestedEvents}-shm`, true);
}

async function storeFileSignature(path: string): Promise<StoreFileSignature> {
  let observedExisting = false;
  try {
    const before = lstatSync(path, { bigint: true });
    observedExisting = true;
    if (!before.isFile()) throw new Error("STORE_SNAPSHOT_FILE_NOT_REGULAR");
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1024 })) {
      hash.update(chunk);
    }
    const after = lstatSync(path, { bigint: true });
    if (!after.isFile()) throw new Error("STORE_SNAPSHOT_FILE_NOT_REGULAR");
    const stable = before.size === after.size
      && before.mtimeNs === after.mtimeNs
      && before.ctimeNs === after.ctimeNs
      && before.ino === after.ino;
    return {
      exists: true,
      stable,
      size: after.size,
      modified: after.mtimeNs,
      changed: after.ctimeNs,
      fileId: after.ino,
      digest: hash.digest("hex"),
    };
  } catch (error) {
    if (!observedExisting && caughtErrorCode(error) === "ENOENT") {
      return { exists: false, stable: true };
    }
    throw error;
  }
}

function sameStoreFileSignature(
  left: StoreFileSignature,
  right: StoreFileSignature,
): boolean {
  return left.exists === right.exists
    && left.stable
    && right.stable
    && left.size === right.size
    && left.modified === right.modified
    && left.changed === right.changed
    && left.fileId === right.fileId
    && left.digest === right.digest;
}

function sameStoreFileContents(
  source: StoreFileSignature,
  snapshot: StoreFileSignature,
): boolean {
  return source.exists === snapshot.exists
    && source.stable
    && snapshot.stable
    && source.size === snapshot.size
    && source.digest === snapshot.digest;
}

function snapshotRoute(route: ProjectStoreRoute, storeRoot: string): ProjectStoreRoute {
  return {
    kind: route.kind,
    storeRoot,
    eventsPath: join(storeRoot, "events.sqlite"),
    storeManifestPath: join(storeRoot, "store-manifest.json"),
    projectionManifestPath: join(storeRoot, "current-projection.json"),
  };
}

export interface CanonicalTemporaryDirectoryDependencies {
  temporaryRoot(): string;
  create(path: string): string;
  canonicalize(path: string): string;
  remove(path: string): void;
}

const DEFAULT_CANONICAL_TEMPORARY_DIRECTORY_DEPENDENCIES: CanonicalTemporaryDirectoryDependencies = {
  temporaryRoot: tmpdir,
  create: mkdtempSync,
  canonicalize: realpathSync.native,
  remove(path) { rmSync(path, { recursive: true, force: true }); },
};

export function createCanonicalTemporaryDirectory(
  prefix: string,
  dependencies: CanonicalTemporaryDirectoryDependencies
    = DEFAULT_CANONICAL_TEMPORARY_DIRECTORY_DEPENDENCIES,
): string {
  const rawDirectory = dependencies.create(join(dependencies.temporaryRoot(), prefix));
  try {
    return resolve(dependencies.canonicalize(rawDirectory));
  } catch (error) {
    try {
      dependencies.remove(rawDirectory);
    } finally {
      throw error;
    }
  }
}

async function withStableStoreSnapshot<T>(
  route: ProjectStoreRoute,
  inspect: (snapshot: ProjectStoreRoute) => Promise<T>,
): Promise<T> {
  const sourceFiles = [route.eventsPath, `${route.eventsPath}-wal`] as const;
  const sourceShmPath = `${route.eventsPath}-shm`;
  for (let attempt = 0; attempt < MAXIMUM_STABLE_SNAPSHOT_ATTEMPTS; attempt += 1) {
    const directory = createCanonicalTemporaryDirectory("memory-vault-store-snapshot-");
    try {
      validateCanonicalStoreSource(route);
      await storeFileSignature(sourceShmPath);
      const before = await Promise.all(sourceFiles.map(storeFileSignature));
      if (!before[0].exists) throw new ProjectBindingError("STORE_UNAVAILABLE");
      const snapshot = snapshotRoute(route, directory);
      for (let index = 0; index < sourceFiles.length; index += 1) {
        if (!before[index].exists) continue;
        const destination = index === 0
          ? snapshot.eventsPath
          : `${snapshot.eventsPath}-wal`;
        copyFileSync(sourceFiles[index], destination);
      }
      const after = await Promise.all(sourceFiles.map(storeFileSignature));
      await storeFileSignature(sourceShmPath);
      validateCanonicalStoreSource(route);
      const snapshotFiles = [snapshot.eventsPath, `${snapshot.eventsPath}-wal`] as const;
      const copied = await Promise.all(snapshotFiles.map(storeFileSignature));
      if (
        before.every((signature, index) => sameStoreFileSignature(signature, after[index]))
        && after.every((signature, index) => sameStoreFileContents(signature, copied[index]))
      ) {
        return await inspect(snapshot);
      }
    } catch (error) {
      if (error instanceof ProjectBindingError) throw error;
      if (attempt + 1 === MAXIMUM_STABLE_SNAPSHOT_ATTEMPTS) {
        throw new ProjectBindingError("STORE_UNAVAILABLE");
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
  throw new ProjectBindingError("STORE_UNAVAILABLE");
}

function blockedInspection(
  code: string,
  summary: ProjectInitializationSummary,
): ProjectInitializationInspection {
  const description = describeProjectBindingFailure(code);
  return {
    state: "blocked",
    code: description.code,
    message: description.message,
    summary,
    remediation: description.remediation,
  };
}

function routedSummary(
  projectRoot: string,
  vaultRoot: string,
  route: ProjectStoreRoute,
  projectId: string,
  vaultId: string,
  storeId?: string,
): RoutedProjectInitializationSummary {
  return {
    projectRoot,
    vaultRoot,
    routeState: "resolved",
    storeRoot: route.storeRoot,
    eventsPath: route.eventsPath,
    projectId,
    vaultId,
    ...(storeId === undefined ? {} : { storeId }),
  };
}

export function createProjectInitializationInspector(
  identityProbe: ProjectStoreIdentityProbe,
  overrides: Partial<Omit<InitializationInspectorDependencies, "identityProbe">> = {},
): (projectRoot: string, vaultRoot: string) => Promise<ProjectInitializationInspection> {
  const dependencies: InitializationInspectorDependencies = {
    descriptorRepository: overrides.descriptorRepository ?? new ProjectDescriptorRepository(),
    workspaceResolver: overrides.workspaceResolver
      ?? new GitWorkspaceResolver(new SpawnSyncGitCommandRunner()),
    router: overrides.router ?? new ProjectStoreRouter(),
    manifestRepository: overrides.manifestRepository ?? new StoreManifestRepository(),
    identityProbe,
    pathExists: overrides.pathExists ?? existsSync,
  };

  return async (projectRoot, vaultRoot) => {
    const descriptorInspection = dependencies.descriptorRepository.inspect(vaultRoot);
    if (descriptorInspection.status === "missing") {
      return {
        state: "new-project",
        summary: { projectRoot, vaultRoot, routeState: "pending-project-identity" },
        remediation: ["rerun with --apply"],
      };
    }
    if (descriptorInspection.status === "invalid") {
      return blockedInspection("PROJECT_DESCRIPTOR_INVALID", {
        projectRoot,
        vaultRoot,
        routeState: "pending-project-identity",
      });
    }

    const descriptor = descriptorInspection.descriptor;
    let route: ProjectStoreRoute;
    try {
      const workspace = dependencies.workspaceResolver.inspect(projectRoot, descriptor);
      route = dependencies.router.route(descriptor, vaultRoot, workspace);
    } catch (error) {
      const code = error instanceof GitWorkspaceResolutionError
        ? error.code === "GIT_PROBE_FAILED" ? "GIT_PROBE_FAILED" : "WORKSPACE_AMBIGUOUS"
        : "STORE_ROUTE_INVALID";
      return blockedInspection(code, {
        projectRoot,
        vaultRoot,
        routeState: "pending-project-identity",
      });
    }

    const summary = routedSummary(
      projectRoot,
      vaultRoot,
      route,
      descriptor.projectId,
      descriptor.vaultId,
    );
    const manifestInspection = dependencies.manifestRepository.inspect(route, {
      projectId: descriptor.projectId,
      vaultId: descriptor.vaultId,
    });
    if (manifestInspection.status === "invalid") {
      const code = manifestInspection.issues.some((issue) => issue.includes("PROJECT_ID"))
        ? "PROJECT_ID_MISMATCH"
        : manifestInspection.issues.some((issue) => issue.includes("VAULT_ID"))
          ? "VAULT_ID_MISMATCH"
          : manifestInspection.issues.some((issue) => issue.includes("STORE_ID"))
            ? "STORE_ID_MISMATCH"
            : "STORE_UNAVAILABLE";
      return blockedInspection(code, summary);
    }

    const databaseExists = dependencies.pathExists(route.eventsPath);
    if (manifestInspection.status === "missing") {
      if (!databaseExists) {
        return {
          state: "replica-decision-required",
          summary,
          remediation: ["rerun with --replica initialize-local --apply"],
        };
      }
      try {
        const identity = await withStableStoreSnapshot(route, (snapshot) => (
          dependencies.identityProbe.inspectExisting(snapshot, {
            projectId: descriptor.projectId,
            vaultId: descriptor.vaultId,
          })
        ));
        return {
          state: "recoverable-manifest",
          summary: routedSummary(
            projectRoot,
            vaultRoot,
            route,
            descriptor.projectId,
            descriptor.vaultId,
            identity.storeId,
          ) as InitializedProjectSummary,
          remediation: ["rerun with --apply"],
        };
      } catch (error) {
        return error instanceof ProjectBindingError
          ? blockedInspection(error.code, summary)
          : blockedInspection("STORE_UNAVAILABLE", summary);
      }
    }

    const initialized = routedSummary(
      projectRoot,
      vaultRoot,
      route,
      descriptor.projectId,
      descriptor.vaultId,
      manifestInspection.manifest.storeId,
    ) as InitializedProjectSummary;
    if (!databaseExists) return blockedInspection("STORE_UNAVAILABLE", initialized);
    try {
      await withStableStoreSnapshot(route, (snapshot) => (
        dependencies.identityProbe.verify(snapshot, {
          projectId: descriptor.projectId,
          vaultId: descriptor.vaultId,
          storeId: manifestInspection.manifest.storeId,
        })
      ));
      return { state: "initialized", summary: initialized, remediation: [] };
    } catch (error) {
      return error instanceof ProjectBindingError
        ? blockedInspection(error.code, initialized)
        : blockedInspection("STORE_UNAVAILABLE", initialized);
    }
  };
}

function createWorkspaceAuthorityInspector(dependencies: {
  descriptorRepository: ProjectDescriptorRepository;
  workspaceResolver: GitWorkspaceResolver;
  router: ProjectStoreRouter;
  manifestRepository: StoreManifestRepository;
}): (
  projectRoot: string,
  vaultRoot: string,
) => Promise<OrchestratorWorkspaceAuthority> {
  return async (projectRoot, vaultRoot) => {
    const descriptorInspection = dependencies.descriptorRepository.inspect(vaultRoot);
    if (descriptorInspection.status !== "valid") {
      throw new Error("ADMIN_SNAPSHOT_INVALID");
    }
    const descriptor = descriptorInspection.descriptor;
    const workspace = dependencies.workspaceResolver.inspect(projectRoot, descriptor);
    const storeRoute = dependencies.router.route(descriptor, vaultRoot, workspace);
    const manifestInspection = dependencies.manifestRepository.inspect(storeRoute, {
      projectId: descriptor.projectId,
      vaultId: descriptor.vaultId,
    });
    if (manifestInspection.status !== "valid") {
      throw new Error("ADMIN_SNAPSHOT_INVALID");
    }
    return {
      descriptorPath: descriptorInspection.path,
      projectId: descriptor.projectId,
      vaultId: descriptor.vaultId,
      storeId: manifestInspection.manifest.storeId,
      workspaceId: workspace.workspaceId,
      storeRoute,
      workspace,
    };
  };
}

export function createOrchestratorAdminDependencies(
  workerUrl: URL,
): OrchestratorAdminDependencies {
  const identityProbe = new WorkerProjectStoreIdentityProbe({
    workerUrl,
    requestTimeoutMs: 10_000,
  });
  const descriptorRepository = new ProjectDescriptorRepository();
  const workspaceResolver = new GitWorkspaceResolver(new SpawnSyncGitCommandRunner());
  const router = new ProjectStoreRouter();
  const manifestRepository = new StoreManifestRepository();
  const bindingService = new ProjectBindingService({
    identityProbe,
    descriptorRepository,
    workspaceResolver,
    router,
    manifestRepository,
  });
  const inspectInitialization = createProjectInitializationInspector(identityProbe, {
    descriptorRepository,
    workspaceResolver,
    router,
    manifestRepository,
  });
  const inspectWorkspaceAuthority = createWorkspaceAuthorityInspector({
    descriptorRepository,
    workspaceResolver,
    router,
    manifestRepository,
  });
  return {
    async runtimeProbe() {
      const directory = mkdtempSync(join(tmpdir(), "memory-vault-runtime-"));
      try {
        return await probeRuntimeCapabilities(join(directory, "capabilities.sqlite"));
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
    inspectInitialization,
    inspectWorkspaceAuthority,
    bootstrap: {
      async initialize(input) {
        const { DefaultProjectStoreBootstrapService } = await import(
          "../orchestrator/storage/project-store-bootstrap.service.js"
        );
        return new DefaultProjectStoreBootstrapService().initialize(input);
      },
    },
    bindingService,
    executorFactory(context) {
      return new ProjectStoreExecutor({
        workerUrl,
        context,
        maxPending: DEFAULT_MAX_PENDING,
        requestTimeoutMs: 30_000,
        closeTimeoutMs: 10_000,
        executorLeaseMs: 15_000,
        heartbeatIntervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS,
      });
    },
    integrityRecorder: {
      async record(context, report) {
        manifestRepository.recordIntegrity(context.binding.storeRoute, {
          projectId: context.binding.projectId,
          vaultId: context.binding.vaultId,
          storeId: context.binding.storeId,
        }, {
          ok: report.ok,
          schemaFingerprint: report.schemaFingerprint,
          terminalEventHash: report.terminalEventHash,
        });
      },
    },
    clientInstanceId: randomUUID,
  };
}
