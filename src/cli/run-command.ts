import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
} from "../orchestrator/identity/contracts.js";
import {
  GitWorkspaceResolutionError,
  GitWorkspaceResolver,
  SpawnSyncGitCommandRunner,
} from "../orchestrator/identity/git-workspace.resolver.js";
import {
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
import { ProjectDescriptorRepository } from "../orchestrator/identity/project-descriptor.repository.js";
import { ProjectStoreRouter } from "../orchestrator/identity/project-store.router.js";
import { StoreManifestRepository } from "../orchestrator/identity/store-manifest.repository.js";
import type { IntegrityReport } from "../orchestrator/integrity/integrity.types.js";
import {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_MAX_PENDING,
  ProjectStoreExecutor,
  ProjectStoreWorkerError,
} from "../orchestrator/runtime/project-store-executor.js";
import { WorkerProjectStoreIdentityProbe } from "../orchestrator/runtime/project-store-identity-probe.js";
import {
  probeRuntimeCapabilities,
  type RuntimeCapabilityReport,
  type RuntimeCapabilityResult,
} from "../orchestrator/runtime/runtime-capabilities.js";
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

export interface OrchestratorAdminDependencies {
  runtimeProbe(): Promise<RuntimeCapabilityResult>;
  inspectInitialization(
    projectRoot: string,
    vaultRoot: string,
  ): Promise<ProjectInitializationInspection>;
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

class SafeAdminError extends Error {
  constructor(readonly failure: SafeFailure) {
    super(failure.code);
    this.name = "SafeAdminError";
  }
}

function writeJson(writer: (text: string) => void, value: unknown, compact = false): void {
  writer(`${JSON.stringify(value, null, compact ? undefined : 2)}\n`);
}

function usageFailure(code: string): SafeFailure {
  const messages: Record<string, string> = {
    PROJECT_ROOT_NOT_EXPLICIT: "A literal --project-root is required",
    VAULT_ROOT_NOT_EXPLICIT: "A literal --vault is required",
    PROJECT_ROOT_MISSING: "The explicit project root is unavailable",
    VAULT_ROOT_MISSING: "The explicit vault root is unavailable or outside the project root",
  };
  return {
    ok: false,
    code,
    message: messages[code] ?? "Invalid command-line input",
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

function runtimeSnapshot(result: RuntimeCapabilityResult): RuntimeCapabilityReport {
  if (!result.ok) {
    throw new SafeAdminError({
      ok: false,
      code: "SQLITE_CAPABILITY_MISSING",
      message: "Required SQLite runtime capabilities are unavailable",
      remediation: ["run memory-vault diagnose and restore the required Node.js/SQLite runtime"],
    });
  }
  return {
    nodeVersion: result.nodeVersion,
    sqliteVersion: result.sqliteVersion,
    nodeVersionAtLeastMinimum: result.nodeVersionAtLeastMinimum,
    sqliteVersionAtLeastMinimum: result.sqliteVersionAtLeastMinimum,
    nodeSqlite: result.nodeSqlite,
    wal: result.wal,
    fts5: result.fts5,
    foreignKeys: result.foreignKeys,
    synchronousFull: result.synchronousFull,
    busyTimeoutMs: result.busyTimeoutMs,
    trustedSchemaOff: result.trustedSchemaOff,
    transactionRollback: result.transactionRollback,
    applicationId: result.applicationId,
  };
}

function routeSnapshot(route: ProjectStoreRoute): ProjectStoreRoute {
  return {
    kind: route.kind,
    storeRoot: route.storeRoot,
    eventsPath: route.eventsPath,
    storeManifestPath: route.storeManifestPath,
    projectionManifestPath: route.projectionManifestPath,
  };
}

function bootstrapSnapshot(result: ProjectStoreBootstrapResult): ProjectStoreBootstrapResult {
  const lastIntegrity = result.manifest.lastIntegrity.status === "never"
    ? { status: "never" as const }
    : {
        status: result.manifest.lastIntegrity.status,
        checkedAt: result.manifest.lastIntegrity.checkedAt,
        schemaFingerprint: result.manifest.lastIntegrity.schemaFingerprint,
        terminalEventHash: result.manifest.lastIntegrity.terminalEventHash,
      };
  return {
    descriptor: {
      schemaVersion: 1,
      projectId: result.descriptor.projectId,
      vaultId: result.descriptor.vaultId,
      createdAt: result.descriptor.createdAt,
    },
    manifest: {
      schemaVersion: 1,
      storeId: result.manifest.storeId,
      projectId: result.manifest.projectId,
      vaultId: result.manifest.vaultId,
      createdAt: result.manifest.createdAt,
      lastIntegrity,
    },
    route: routeSnapshot(result.route),
    createdDescriptor: result.createdDescriptor,
    createdStore: result.createdStore,
    recoveredManifest: result.recoveredManifest,
  };
}

function summarySnapshot(summary: ProjectInitializationSummary): ProjectInitializationSummary {
  if (summary.routeState === "pending-project-identity") {
    return {
      projectRoot: summary.projectRoot,
      vaultRoot: summary.vaultRoot,
      routeState: "pending-project-identity",
    };
  }
  return {
    projectRoot: summary.projectRoot,
    vaultRoot: summary.vaultRoot,
    routeState: "resolved",
    storeRoot: summary.storeRoot,
    eventsPath: summary.eventsPath,
    projectId: summary.projectId,
    vaultId: summary.vaultId,
    ...(summary.storeId === undefined ? {} : { storeId: summary.storeId }),
  };
}

function inspectionSnapshot(
  inspection: ProjectInitializationInspection,
): ProjectInitializationInspection {
  switch (inspection.state) {
    case "new-project":
      return {
        state: "new-project",
        summary: summarySnapshot(inspection.summary) as PendingProjectInitializationSummary,
        remediation: ["rerun with --apply"],
      };
    case "replica-decision-required":
      return {
        state: "replica-decision-required",
        summary: summarySnapshot(inspection.summary) as RoutedProjectInitializationSummary,
        remediation: ["rerun with --replica initialize-local --apply"],
      };
    case "recoverable-manifest":
      return {
        state: "recoverable-manifest",
        summary: summarySnapshot(inspection.summary) as InitializedProjectSummary,
        remediation: ["rerun with --apply"],
      };
    case "initialized":
      return {
        state: "initialized",
        summary: summarySnapshot(inspection.summary) as InitializedProjectSummary,
        remediation: [],
      };
    case "blocked":
      const description = describeProjectBindingFailure(inspection.code);
      return {
        state: "blocked",
        code: description.code,
        message: description.message,
        summary: summarySnapshot(inspection.summary),
        remediation: description.remediation,
      };
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
      return { kind: "safe", failure: Reflect.get(error, "failure") };
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
  const message = Reflect.get(value, "message");
  if (typeof code !== "string" || typeof message !== "string") return UNKNOWN_ADMIN_FAILURE;
  const remediation = Reflect.get(value, "remediation");
  const summary = Reflect.get(value, "summary");
  return {
    ok: false,
    code,
    message,
    ...(Array.isArray(remediation) && remediation.every((item) => typeof item === "string")
      ? { remediation: [...remediation] }
      : {}),
    ...(summary === undefined
      ? {}
      : { summary: summarySnapshot(summary as ProjectInitializationSummary) }),
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
        failure: typeof classified.code === "string"
          ? usageFailure(classified.code)
          : UNKNOWN_ADMIN_FAILURE,
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
        );
        if (inspection.state === "blocked") {
          throw new SafeAdminError({
            ok: false,
            code: inspection.code,
            message: inspection.message,
            remediation: [...inspection.remediation],
            summary: summarySnapshot(inspection.summary),
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
      writeJson(io.stdout, { action: "initialized", result });
      return 0;
    }

    const resolution = await dependencies.bindingService.establish(request);
    if (!resolution.ok) throw bindingFailure(resolution);

    if (options.command === "orchestrator-status") {
      const binding = resolution.binding;
      writeJson(io.stdout, {
        action: "status",
        projectId: binding.projectId,
        vaultId: binding.vaultId,
        storeId: binding.storeId,
        workspaceId: binding.workspaceId,
        eventsPath: binding.storeRoute.eventsPath,
        runtime,
      });
      return 0;
    }

    const context = await dependencies.bindingService.revalidate(resolution.binding);
    const executor = dependencies.executorFactory(context);
    let report: IntegrityReport;
    try {
      await executor.open();
      report = options.fullIntegrity
        ? await executor.fullIntegrity()
        : await executor.quickIntegrity();
    } finally {
      await executor.close();
    }
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

async function storeFileSignature(path: string): Promise<StoreFileSignature> {
  try {
    const before = statSync(path, { bigint: true });
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1024 })) {
      hash.update(chunk);
    }
    const after = statSync(path, { bigint: true });
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
  } catch {
    return { exists: false, stable: true };
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

async function withStableStoreSnapshot<T>(
  route: ProjectStoreRoute,
  inspect: (snapshot: ProjectStoreRoute) => Promise<T>,
): Promise<T> {
  const sourceFiles = [route.eventsPath, `${route.eventsPath}-wal`] as const;
  for (let attempt = 0; attempt < MAXIMUM_STABLE_SNAPSHOT_ATTEMPTS; attempt += 1) {
    const directory = mkdtempSync(join(tmpdir(), "memory-vault-store-snapshot-"));
    try {
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

export function createOrchestratorAdminDependencies(
  workerUrl: URL,
): OrchestratorAdminDependencies {
  const identityProbe = new WorkerProjectStoreIdentityProbe({
    workerUrl,
    requestTimeoutMs: 10_000,
  });
  const bindingService = new ProjectBindingService({ identityProbe });
  const inspectInitialization = createProjectInitializationInspector(identityProbe);
  const integrityManifestRepository = new StoreManifestRepository();
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
        integrityManifestRepository.recordIntegrity(context.binding.storeRoute, {
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
