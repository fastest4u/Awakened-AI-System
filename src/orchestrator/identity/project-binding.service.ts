import { createHash, randomUUID } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { canonicalJson } from "../serialization/canonical-json.js";
import { assertContainedPath, canonicalExistingDirectory } from "./canonical-path.js";
import type {
  ProjectBinding,
  ProjectContext,
  ProjectDescriptorV1,
  ProjectId,
  ProjectStoreRoute,
  StoreId,
  VaultId,
  WorkspaceSnapshot,
} from "./contracts.js";
import {
  deriveGitWorkspaceId,
  deriveNonGitWorkspaceId,
  GitWorkspaceResolutionError,
  GitWorkspaceResolver,
  SpawnSyncGitCommandRunner,
} from "./git-workspace.resolver.js";
import {
  parseTrustedProjectBindingRequest,
  type TrustedProjectBindingRequest,
} from "./project-binding.request.js";
import {
  ProjectDescriptorRepository,
  type DescriptorInspection,
} from "./project-descriptor.repository.js";
import { ProjectStoreRouter } from "./project-store.router.js";
import {
  StoreManifestRepository,
  type ExpectedStoreManifestIdentity,
  type StoreManifestInspection,
} from "./store-manifest.repository.js";
import type { StoreManifestV1 } from "./store-manifest.schema.js";

export type ProjectBindingFailureCode =
  | "PROJECT_BINDING_REQUIRED"
  | "PROJECT_ROOT_NOT_EXPLICIT"
  | "PROJECT_ROOT_MISSING"
  | "VAULT_ROOT_MISSING"
  | "PROJECT_DESCRIPTOR_MISSING"
  | "PROJECT_DESCRIPTOR_INVALID"
  | "PROJECT_REPLICA_DECISION_REQUIRED"
  | "STORE_MANIFEST_RECOVERY_REQUIRED"
  | "PROJECT_ID_MISMATCH"
  | "VAULT_ID_MISMATCH"
  | "STORE_ID_MISMATCH"
  | "WORKSPACE_AMBIGUOUS"
  | "GIT_PROBE_FAILED"
  | "STORE_ROUTE_INVALID"
  | "STORE_UNAVAILABLE";

export interface ProjectBindingFailure {
  ok: false;
  code: ProjectBindingFailureCode;
  message: string;
  details: Record<string, unknown>;
  remediation: string[];
}

export type ProjectBindingResolution =
  | { ok: true; binding: ProjectBinding }
  | ProjectBindingFailure;

export interface ProjectBindingProvider {
  current(): ProjectBinding | null;
  require(): ProjectBinding;
}

export interface ProjectStoreIdentity {
  projectId: ProjectId;
  vaultId: VaultId;
  storeId: StoreId;
}

/**
 * Implementations own their SQLite handle and close it before either method
 * resolves. The binding service never opens SQLite on the MCP event-loop
 * thread.
 */
export interface ProjectStoreIdentityProbe {
  verify(route: ProjectStoreRoute, expected: ProjectStoreIdentity): Promise<void>;
  inspectExisting(
    route: ProjectStoreRoute,
    expected: Pick<ProjectStoreIdentity, "projectId" | "vaultId">,
  ): Promise<ProjectStoreIdentity>;
}

interface DescriptorInspector {
  inspect(vaultRoot: string): DescriptorInspection;
}

interface WorkspaceInspector {
  inspect(projectRoot: string, descriptor: ProjectDescriptorV1): WorkspaceSnapshot;
}

interface StoreRouter {
  route(
    descriptor: ProjectDescriptorV1,
    vaultRoot: string,
    workspace: WorkspaceSnapshot,
  ): ProjectStoreRoute;
}

interface ManifestInspector {
  inspect(
    route: ProjectStoreRoute,
    expected: ExpectedStoreManifestIdentity,
  ): StoreManifestInspection;
}

export interface ProjectBindingServiceDependencies {
  identityProbe: ProjectStoreIdentityProbe;
  descriptorRepository?: DescriptorInspector;
  workspaceResolver?: WorkspaceInspector;
  router?: StoreRouter;
  manifestRepository?: ManifestInspector;
  now?: () => string;
  randomId?: () => string;
  pathExists?: (path: string) => boolean;
}

interface ResolvedDependencies {
  identityProbe: ProjectStoreIdentityProbe;
  descriptorRepository: DescriptorInspector;
  workspaceResolver: WorkspaceInspector;
  router: StoreRouter;
  manifestRepository: ManifestInspector;
  now: () => string;
  randomId: () => string;
  pathExists: (path: string) => boolean;
}

interface BindingBaseline {
  descriptor: string;
  manifest: string;
}

function immutableManifestFingerprint(manifest: StoreManifestV1): string {
  return canonicalJson({
    schemaVersion: manifest.schemaVersion,
    storeId: manifest.storeId,
    projectId: manifest.projectId,
    vaultId: manifest.vaultId,
    createdAt: manifest.createdAt,
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDENTITY_FAILURE_CODES = new Set<ProjectBindingFailureCode>([
  "PROJECT_ID_MISMATCH",
  "VAULT_ID_MISMATCH",
  "STORE_ID_MISMATCH",
]);

const FAILURE_MESSAGES: Record<ProjectBindingFailureCode, string> = {
  PROJECT_BINDING_REQUIRED: "A trusted project binding is required",
  PROJECT_ROOT_NOT_EXPLICIT: "An explicit project root is required",
  PROJECT_ROOT_MISSING: "The configured project root is unavailable",
  VAULT_ROOT_MISSING: "The configured vault root is unavailable",
  PROJECT_DESCRIPTOR_MISSING: "The project identity descriptor is missing",
  PROJECT_DESCRIPTOR_INVALID: "The project identity descriptor is invalid",
  PROJECT_REPLICA_DECISION_REQUIRED: "This project clone requires an explicit replica decision",
  STORE_MANIFEST_RECOVERY_REQUIRED: "The existing store requires explicit manifest recovery",
  PROJECT_ID_MISMATCH: "Project identity does not match the bound store",
  VAULT_ID_MISMATCH: "Vault identity does not match the bound store",
  STORE_ID_MISMATCH: "Store identity does not match the manifest",
  WORKSPACE_AMBIGUOUS: "The bound workspace identity is unavailable or changed",
  GIT_PROBE_FAILED: "Git workspace identity could not be verified",
  STORE_ROUTE_INVALID: "The project store route is invalid",
  STORE_UNAVAILABLE: "The authoritative project store is unavailable",
};

const REMEDIATION: Record<ProjectBindingFailureCode, string[]> = {
  PROJECT_BINDING_REQUIRED: ["establish a new trusted project binding"],
  PROJECT_ROOT_NOT_EXPLICIT: ["supply a literal trusted project root"],
  PROJECT_ROOT_MISSING: ["restore or explicitly reselect the project root"],
  VAULT_ROOT_MISSING: ["restore or explicitly reselect the project vault"],
  PROJECT_DESCRIPTOR_MISSING: ["run orchestrator-init --apply for the intended project"],
  PROJECT_DESCRIPTOR_INVALID: ["repair or explicitly recreate project identity before binding"],
  PROJECT_REPLICA_DECISION_REQUIRED: [
    "run orchestrator-init --replica initialize-local --apply",
    "or attach/import an existing replica",
    "or explicitly fork as a new project",
  ],
  STORE_MANIFEST_RECOVERY_REQUIRED: [
    "run orchestrator-init --apply to verify and recover the manifest",
  ],
  PROJECT_ID_MISMATCH: ["select the intended project or perform an explicit identity migration"],
  VAULT_ID_MISMATCH: ["select the intended vault or perform an explicit vault migration"],
  STORE_ID_MISMATCH: ["attach the intended store or recover its manifest explicitly"],
  WORKSPACE_AMBIGUOUS: ["establish a new binding for the intended workspace"],
  GIT_PROBE_FAILED: ["resolve the Git diagnostic and retry explicit binding"],
  STORE_ROUTE_INVALID: ["repair the canonical project store route before binding"],
  STORE_UNAVAILABLE: ["verify the existing project store and retry"],
};

const PROJECT_BINDING_FAILURE_CODES = new Set<ProjectBindingFailureCode>(
  Object.keys(FAILURE_MESSAGES) as ProjectBindingFailureCode[],
);

export interface SafeProjectBindingFailureDescription {
  code: ProjectBindingFailureCode;
  message: string;
  remediation: string[];
}

export function describeProjectBindingFailure(
  code: unknown,
): SafeProjectBindingFailureDescription {
  const safeCode = typeof code === "string"
    && PROJECT_BINDING_FAILURE_CODES.has(code as ProjectBindingFailureCode)
    ? code as ProjectBindingFailureCode
    : "PROJECT_BINDING_REQUIRED";
  return {
    code: safeCode,
    message: FAILURE_MESSAGES[safeCode],
    remediation: [...REMEDIATION[safeCode]],
  };
}

const TRUSTED_PROJECT_BINDING_ERROR_CODES = new WeakMap<object, ProjectBindingFailureCode>();

export class ProjectBindingError extends Error {
  readonly remediation: string[];

  constructor(
    readonly code: ProjectBindingFailureCode,
    readonly details: Record<string, unknown> = {},
  ) {
    super(describeProjectBindingFailure(code).message);
    TRUSTED_PROJECT_BINDING_ERROR_CODES.set(this, code);
    this.name = "ProjectBindingError";
    this.remediation = describeProjectBindingFailure(code).remediation;
  }
}

function failure(
  code: ProjectBindingFailureCode,
  details: Record<string, unknown> = {},
): ProjectBindingFailure {
  const description = describeProjectBindingFailure(code);
  return {
    ok: false,
    code: description.code,
    message: description.message,
    details,
    remediation: description.remediation,
  };
}

function exactErrorCode(error: unknown): string | undefined {
  try {
    if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
    const code = Reflect.get(error, "code") as unknown;
    return typeof code === "string" ? code : undefined;
  } catch {
    return undefined;
  }
}

function safeCaughtFailureCode(error: unknown): ProjectBindingFailureCode {
  if ((typeof error !== "object" || error === null) && typeof error !== "function") {
    return "STORE_UNAVAILABLE";
  }
  return TRUSTED_PROJECT_BINDING_ERROR_CODES.get(error as object) ?? "STORE_UNAVAILABLE";
}

function probeError(error: unknown): ProjectBindingError {
  if ((typeof error === "object" && error !== null) || typeof error === "function") {
    const trustedCode = TRUSTED_PROJECT_BINDING_ERROR_CODES.get(error as object);
    if (trustedCode !== undefined) return new ProjectBindingError(trustedCode);
  }
  const code = exactErrorCode(error);
  if (code !== undefined && IDENTITY_FAILURE_CODES.has(code as ProjectBindingFailureCode)) {
    return new ProjectBindingError(code as ProjectBindingFailureCode);
  }
  return new ProjectBindingError("STORE_UNAVAILABLE");
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function isLexicallyCanonical(path: string): boolean {
  const normalized = resolve(path);
  return process.platform === "win32"
    ? path.toLowerCase() === normalized.toLowerCase()
    : path === normalized;
}

function isContained(root: string, target: string): boolean {
  const child = relative(root, target);
  return child === ""
    || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function assertAbsoluteCanonicalShape(path: string): void {
  if (typeof path !== "string" || path.length === 0 || !isAbsolute(path) || !isLexicallyCanonical(path)) {
    throw new ProjectBindingError("STORE_ROUTE_INVALID");
  }
}

function validateWorkspace(
  workspace: WorkspaceSnapshot,
  descriptor: ProjectDescriptorV1,
  projectRoot: string,
): void {
  if (workspace.kind === "non-git") {
    if (
      !samePath(workspace.workspaceRoot, projectRoot)
      || workspace.workspaceId !== deriveNonGitWorkspaceId(descriptor.projectId, descriptor.vaultId)
    ) {
      throw new ProjectBindingError("WORKSPACE_AMBIGUOUS");
    }
    return;
  }

  if (
    !isAbsolute(workspace.worktreeRoot)
    || !isAbsolute(workspace.gitDir)
    || !isAbsolute(workspace.gitCommonDir)
    || !isLexicallyCanonical(workspace.worktreeRoot)
    || !isLexicallyCanonical(workspace.gitDir)
    || !isLexicallyCanonical(workspace.gitCommonDir)
    || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(workspace.headCommit)
    || (workspace.detached ? workspace.branchRef !== null : workspace.branchRef === null)
  ) {
    throw new ProjectBindingError("WORKSPACE_AMBIGUOUS");
  }
  let expectedWorkspaceId: string;
  try {
    expectedWorkspaceId = deriveGitWorkspaceId(
      descriptor.projectId,
      workspace.gitCommonDir,
      workspace.gitDir,
    );
  } catch {
    throw new ProjectBindingError("WORKSPACE_AMBIGUOUS");
  }
  if (workspace.workspaceId !== expectedWorkspaceId) {
    throw new ProjectBindingError("WORKSPACE_AMBIGUOUS");
  }
}

function validateRoute(
  route: ProjectStoreRoute,
  workspace: WorkspaceSnapshot,
  descriptor: ProjectDescriptorV1,
  vaultRoot: string,
  pathExists: (path: string) => boolean,
): void {
  const expectedKind = workspace.kind === "git" ? "git-common" : "vault-local";
  if (route.kind !== expectedKind) throw new ProjectBindingError("STORE_ROUTE_INVALID");
  const routeBase = workspace.kind === "git" ? workspace.gitCommonDir : vaultRoot;
  const expectedStoreRoot = workspace.kind === "git"
    ? resolve(routeBase, "project-memory", descriptor.projectId, "v2")
    : resolve(routeBase, ".memory-mcp", "v2");
  try {
    assertContainedPath(routeBase, expectedStoreRoot);
  } catch {
    throw new ProjectBindingError("STORE_ROUTE_INVALID");
  }
  const expectedRoute: ProjectStoreRoute = {
    kind: expectedKind,
    storeRoot: expectedStoreRoot,
    eventsPath: join(expectedStoreRoot, "events.sqlite"),
    storeManifestPath: join(expectedStoreRoot, "store-manifest.json"),
    projectionManifestPath: join(expectedStoreRoot, "current-projection.json"),
  };
  for (const path of [
    route.storeRoot,
    route.eventsPath,
    route.storeManifestPath,
    route.projectionManifestPath,
  ]) {
    assertAbsoluteCanonicalShape(path);
  }
  if (
    !samePath(route.storeRoot, expectedRoute.storeRoot)
    || !samePath(route.eventsPath, expectedRoute.eventsPath)
    || !samePath(route.storeManifestPath, expectedRoute.storeManifestPath)
    || !samePath(route.projectionManifestPath, expectedRoute.projectionManifestPath)
    || !samePath(dirname(route.eventsPath), route.storeRoot)
    || !samePath(dirname(route.storeManifestPath), route.storeRoot)
    || !samePath(dirname(route.projectionManifestPath), route.storeRoot)
    || basename(route.eventsPath) !== "events.sqlite"
    || basename(route.storeManifestPath) !== "store-manifest.json"
    || basename(route.projectionManifestPath) !== "current-projection.json"
    || !isContained(route.storeRoot, route.eventsPath)
    || !isContained(route.storeRoot, route.storeManifestPath)
    || !isContained(route.storeRoot, route.projectionManifestPath)
  ) {
    throw new ProjectBindingError("STORE_ROUTE_INVALID");
  }

  if (pathExists(route.storeRoot)) {
    let canonicalRoot: string;
    try {
      canonicalRoot = canonicalExistingDirectory(route.storeRoot);
    } catch {
      throw new ProjectBindingError("STORE_ROUTE_INVALID");
    }
    if (!samePath(canonicalRoot, route.storeRoot)) {
      throw new ProjectBindingError("STORE_ROUTE_INVALID");
    }
  }
  if (pathExists(route.eventsPath)) {
    try {
      const canonicalEvents = resolve(realpathSync.native(route.eventsPath));
      if (!samePath(canonicalEvents, route.eventsPath) || !statSync(canonicalEvents).isFile()) {
        throw new ProjectBindingError("STORE_ROUTE_INVALID");
      }
    } catch (error) {
      if (error instanceof ProjectBindingError) throw error;
      throw new ProjectBindingError("STORE_ROUTE_INVALID");
    }
  }
}

function validateDescriptorPath(vaultRoot: string, path: string): void {
  const expected = join(vaultRoot, ".memory-mcp", "project-identity.json");
  if (!isAbsolute(path) || !samePath(path, expected) || !isContained(vaultRoot, path)) {
    throw new ProjectBindingError("PROJECT_DESCRIPTOR_INVALID");
  }
}

function manifestIssueCode(issues: readonly string[]): ProjectBindingFailureCode | undefined {
  if (issues.includes("STORE_MANIFEST_PROJECT_ID_MISMATCH")) return "PROJECT_ID_MISMATCH";
  if (issues.includes("STORE_MANIFEST_VAULT_ID_MISMATCH")) return "VAULT_ID_MISMATCH";
  if (issues.includes("STORE_MANIFEST_STORE_ID_MISMATCH")) return "STORE_ID_MISMATCH";
  return undefined;
}

function validateManifestIdentity(
  manifest: StoreManifestV1,
  descriptor: ProjectDescriptorV1,
): void {
  if (manifest.projectId !== descriptor.projectId) {
    throw new ProjectBindingError("PROJECT_ID_MISMATCH");
  }
  if (manifest.vaultId !== descriptor.vaultId) {
    throw new ProjectBindingError("VAULT_ID_MISMATCH");
  }
  if (!UUID.test(manifest.storeId)) throw new ProjectBindingError("STORE_UNAVAILABLE");
}

function validateInspectedIdentity(
  identity: ProjectStoreIdentity,
  descriptor: ProjectDescriptorV1,
): void {
  if (identity.projectId !== descriptor.projectId) {
    throw new ProjectBindingError("PROJECT_ID_MISMATCH");
  }
  if (identity.vaultId !== descriptor.vaultId) {
    throw new ProjectBindingError("VAULT_ID_MISMATCH");
  }
  if (!UUID.test(identity.storeId)) throw new ProjectBindingError("STORE_UNAVAILABLE");
}

function freezeBinding(binding: ProjectBinding): ProjectBinding {
  Object.freeze(binding.storeRoute);
  Object.freeze(binding.workspace);
  return Object.freeze(binding);
}

function samePrivateBinding(left: ProjectBinding, right: ProjectBinding): boolean {
  return left.projectBindingId === right.projectBindingId
    && left.generation === right.generation
    && left.contextFingerprint === right.contextFingerprint
    && left.source === right.source
    && left.projectId === right.projectId
    && left.vaultId === right.vaultId
    && left.storeId === right.storeId
    && left.workspaceId === right.workspaceId
    && left.clientNamespace === right.clientNamespace
    && left.clientInstanceId === right.clientInstanceId
    && left.actorRole === right.actorRole
    && left.projectRoot === right.projectRoot
    && left.vaultRoot === right.vaultRoot
    && left.descriptorPath === right.descriptorPath
    && left.establishedAt === right.establishedAt
    && canonicalJson(left.storeRoute) === canonicalJson(right.storeRoute)
    && canonicalJson(left.workspace) === canonicalJson(right.workspace);
}

export function computeProjectContextFingerprint(
  binding: Omit<ProjectBinding, "contextFingerprint" | "projectBindingId" | "establishedAt">,
): string {
  const material = {
    generation: binding.generation,
    projectId: binding.projectId,
    vaultId: binding.vaultId,
    storeId: binding.storeId,
    workspaceId: binding.workspaceId,
    projectRoot: binding.projectRoot,
    vaultRoot: binding.vaultRoot,
    eventsPath: binding.storeRoute.eventsPath,
    clientNamespace: binding.clientNamespace,
    clientInstanceId: binding.clientInstanceId,
    actorRole: binding.actorRole,
  };
  return createHash("sha256")
    .update(`project-memory/project-context/v1\n${canonicalJson(material)}`, "utf8")
    .digest("hex");
}

export class ProjectBindingService implements ProjectBindingProvider {
  readonly #dependencies: ResolvedDependencies;
  #binding: ProjectBinding | null = null;
  #baseline: BindingBaseline | null = null;
  #revision = 0n;

  constructor(dependencies: ProjectBindingServiceDependencies) {
    this.#dependencies = {
      identityProbe: dependencies.identityProbe,
      descriptorRepository: dependencies.descriptorRepository ?? new ProjectDescriptorRepository(),
      workspaceResolver: dependencies.workspaceResolver
        ?? new GitWorkspaceResolver(new SpawnSyncGitCommandRunner()),
      router: dependencies.router ?? new ProjectStoreRouter(),
      manifestRepository: dependencies.manifestRepository ?? new StoreManifestRepository(),
      now: dependencies.now ?? (() => new Date().toISOString()),
      randomId: dependencies.randomId ?? randomUUID,
      pathExists: dependencies.pathExists ?? existsSync,
    };
  }

  current(): ProjectBinding | null {
    return this.#binding;
  }

  require(): ProjectBinding {
    if (this.#binding === null) throw new ProjectBindingError("PROJECT_BINDING_REQUIRED");
    return this.#binding;
  }

  async establish(request: TrustedProjectBindingRequest): Promise<ProjectBindingResolution> {
    const revision = this.beginEstablishment();
    try {
      const resolution = await this.establishOwned(request, revision);
      this.assertEstablishmentOwned(revision);
      return resolution;
    } catch (error) {
      this.invalidateIfOwned(revision);
      return failure(safeCaughtFailureCode(error));
    }
  }

  private async establishOwned(
    request: TrustedProjectBindingRequest,
    revision: bigint,
  ): Promise<ProjectBindingResolution> {
    let trusted: TrustedProjectBindingRequest;
    try {
      trusted = parseTrustedProjectBindingRequest(
        request as unknown as Record<string, unknown>,
      );
    } catch (error) {
      if (error instanceof Error && error.message === "PROJECT_ROOT_NOT_EXPLICIT") {
        return failure("PROJECT_ROOT_NOT_EXPLICIT");
      }
      if (error instanceof Error && error.message === "VAULT_ROOT_NOT_EXPLICIT") {
        return failure("VAULT_ROOT_MISSING", { reason: "EXPLICIT_ROOT_REQUIRED" });
      }
      return failure("PROJECT_BINDING_REQUIRED");
    }

    let projectRoot: string;
    try {
      projectRoot = canonicalExistingDirectory(trusted.projectRoot);
    } catch {
      return failure("PROJECT_ROOT_MISSING");
    }
    let vaultRoot: string;
    try {
      vaultRoot = canonicalExistingDirectory(trusted.vaultRoot);
      assertContainedPath(projectRoot, vaultRoot);
    } catch {
      return failure("VAULT_ROOT_MISSING");
    }

    let descriptorInspection: DescriptorInspection;
    try {
      descriptorInspection = this.#dependencies.descriptorRepository.inspect(vaultRoot);
    } catch {
      return failure("PROJECT_DESCRIPTOR_INVALID");
    }
    if (descriptorInspection.status === "missing") {
      return failure("PROJECT_DESCRIPTOR_MISSING", { path: descriptorInspection.path });
    }
    if (descriptorInspection.status === "invalid") {
      return failure("PROJECT_DESCRIPTOR_INVALID", {
        path: descriptorInspection.path,
        issues: [...descriptorInspection.issues],
      });
    }
    try {
      validateDescriptorPath(vaultRoot, descriptorInspection.path);
    } catch (error) {
      return this.resolutionFromError(error, revision);
    }
    const descriptor = descriptorInspection.descriptor;

    let workspace: WorkspaceSnapshot;
    try {
      workspace = this.#dependencies.workspaceResolver.inspect(projectRoot, descriptor);
      validateWorkspace(workspace, descriptor, projectRoot);
    } catch (error) {
      if (error instanceof GitWorkspaceResolutionError) {
        return failure(
          error.code === "GIT_PROBE_FAILED" ? "GIT_PROBE_FAILED" : "WORKSPACE_AMBIGUOUS",
          { reason: error.reason },
        );
      }
      if (error instanceof ProjectBindingError) return this.resolutionFromError(error, revision);
      return failure("GIT_PROBE_FAILED");
    }

    let storeRoute: ProjectStoreRoute;
    try {
      storeRoute = this.#dependencies.router.route(descriptor, vaultRoot, workspace);
      validateRoute(
        storeRoute,
        workspace,
        descriptor,
        vaultRoot,
        this.#dependencies.pathExists,
      );
    } catch (error) {
      return error instanceof ProjectBindingError
        ? this.resolutionFromError(error, revision)
        : failure("STORE_ROUTE_INVALID");
    }

    let manifestInspection: StoreManifestInspection;
    try {
      manifestInspection = this.#dependencies.manifestRepository.inspect(storeRoute, {
        projectId: descriptor.projectId,
        vaultId: descriptor.vaultId,
      });
    } catch {
      return failure("STORE_UNAVAILABLE");
    }
    if (manifestInspection.status === "invalid") {
      const code = manifestIssueCode(manifestInspection.issues);
      return failure(code ?? "STORE_UNAVAILABLE", {
        path: manifestInspection.path,
        issues: [...manifestInspection.issues],
      });
    }
    if (manifestInspection.status === "missing") {
      if (!this.#dependencies.pathExists(storeRoute.eventsPath)) {
        return failure("PROJECT_REPLICA_DECISION_REQUIRED", {
          manifestPath: manifestInspection.path,
        });
      }
      try {
        const identity = await this.#dependencies.identityProbe.inspectExisting(storeRoute, {
          projectId: descriptor.projectId,
          vaultId: descriptor.vaultId,
        });
        this.assertEstablishmentOwned(revision);
        validateInspectedIdentity(identity, descriptor);
      } catch (error) {
        this.assertEstablishmentOwned(revision);
        return this.resolutionFromError(probeError(error), revision);
      }
      return failure("STORE_MANIFEST_RECOVERY_REQUIRED", {
        manifestPath: manifestInspection.path,
      });
    }

    const storeManifest = manifestInspection.manifest;
    try {
      validateManifestIdentity(storeManifest, descriptor);
    } catch (error) {
      return this.resolutionFromError(error, revision);
    }
    if (!samePath(manifestInspection.path, storeRoute.storeManifestPath)) {
      return failure("STORE_ROUTE_INVALID");
    }
    if (!this.#dependencies.pathExists(storeRoute.eventsPath)) {
      return failure("STORE_UNAVAILABLE", { reason: "DATABASE_MISSING" });
    }
    try {
      await this.#dependencies.identityProbe.verify(storeRoute, {
        projectId: descriptor.projectId,
        vaultId: descriptor.vaultId,
        storeId: storeManifest.storeId,
      });
      this.assertEstablishmentOwned(revision);
    } catch (error) {
      this.assertEstablishmentOwned(revision);
      return this.resolutionFromError(probeError(error), revision);
    }

    const bindingWithoutPrivateFields: Omit<
      ProjectBinding,
      "contextFingerprint" | "projectBindingId" | "establishedAt"
    > = {
      generation: trusted.generation,
      source: trusted.source,
      projectId: descriptor.projectId,
      vaultId: descriptor.vaultId,
      storeId: storeManifest.storeId,
      workspaceId: workspace.workspaceId,
      clientNamespace: trusted.clientNamespace,
      clientInstanceId: trusted.clientInstanceId,
      actorRole: trusted.actorRole,
      projectRoot,
      vaultRoot,
      descriptorPath: descriptorInspection.path,
      storeRoute: { ...storeRoute },
      workspace: { ...workspace },
    };
    const contextFingerprint = computeProjectContextFingerprint(bindingWithoutPrivateFields);
    this.assertEstablishmentOwned(revision);
    const projectBindingId = this.#dependencies.randomId();
    const establishedAt = this.#dependencies.now();
    if (!UUID.test(projectBindingId) || typeof establishedAt !== "string") {
      throw new ProjectBindingError("STORE_UNAVAILABLE");
    }
    const binding = freezeBinding({
      ...bindingWithoutPrivateFields,
      projectBindingId,
      contextFingerprint,
      establishedAt,
    });
    const baseline = {
      descriptor: canonicalJson(descriptor),
      manifest: immutableManifestFingerprint(storeManifest),
    };
    this.assertEstablishmentOwned(revision);
    this.#binding = binding;
    this.#baseline = baseline;
    return { ok: true, binding };
  }

  async revalidate(binding: ProjectBinding): Promise<ProjectContext> {
    const revision = this.#revision;
    try {
      const current = this.require();
      const baseline = this.#baseline;
      if (baseline === null || !samePrivateBinding(binding, current)) {
        throw new ProjectBindingError("PROJECT_BINDING_REQUIRED", { reason: "STALE_BINDING" });
      }
      this.assertRevalidationCurrent(revision, current);

      let projectRoot: string;
      let vaultRoot: string;
      try {
        projectRoot = canonicalExistingDirectory(binding.projectRoot);
      } catch {
        throw new ProjectBindingError("PROJECT_ROOT_MISSING");
      }
      try {
        vaultRoot = canonicalExistingDirectory(binding.vaultRoot);
        assertContainedPath(projectRoot, vaultRoot);
      } catch {
        throw new ProjectBindingError("VAULT_ROOT_MISSING");
      }
      if (!samePath(projectRoot, current.projectRoot) || !samePath(vaultRoot, current.vaultRoot)) {
        throw new ProjectBindingError("PROJECT_BINDING_REQUIRED", { reason: "ROOT_CHANGED" });
      }

      const descriptorInspection = this.#dependencies.descriptorRepository.inspect(vaultRoot);
      if (descriptorInspection.status === "missing") {
        throw new ProjectBindingError("PROJECT_DESCRIPTOR_MISSING");
      }
      if (descriptorInspection.status === "invalid") {
        throw new ProjectBindingError("PROJECT_DESCRIPTOR_INVALID");
      }
      validateDescriptorPath(vaultRoot, descriptorInspection.path);
      const descriptor = descriptorInspection.descriptor;
      if (descriptor.projectId !== current.projectId) {
        throw new ProjectBindingError("PROJECT_ID_MISMATCH");
      }
      if (descriptor.vaultId !== current.vaultId) {
        throw new ProjectBindingError("VAULT_ID_MISMATCH");
      }
      if (canonicalJson(descriptor) !== baseline.descriptor) {
        throw new ProjectBindingError("PROJECT_ID_MISMATCH", { reason: "DESCRIPTOR_CHANGED" });
      }

      let workspace: WorkspaceSnapshot;
      try {
        workspace = this.#dependencies.workspaceResolver.inspect(projectRoot, descriptor);
        validateWorkspace(workspace, descriptor, projectRoot);
      } catch (error) {
        if (error instanceof GitWorkspaceResolutionError) {
          throw new ProjectBindingError(
            error.code === "GIT_PROBE_FAILED" ? "GIT_PROBE_FAILED" : "WORKSPACE_AMBIGUOUS",
            { reason: error.reason },
          );
        }
        if (error instanceof ProjectBindingError) throw error;
        throw new ProjectBindingError("GIT_PROBE_FAILED");
      }
      if (canonicalJson(workspace) !== canonicalJson(current.workspace)) {
        throw new ProjectBindingError("WORKSPACE_AMBIGUOUS", { reason: "WORKSPACE_CHANGED" });
      }

      let storeRoute: ProjectStoreRoute;
      try {
        storeRoute = this.#dependencies.router.route(descriptor, vaultRoot, workspace);
        validateRoute(
          storeRoute,
          workspace,
          descriptor,
          vaultRoot,
          this.#dependencies.pathExists,
        );
      } catch (error) {
        if (error instanceof ProjectBindingError) throw error;
        throw new ProjectBindingError("STORE_ROUTE_INVALID");
      }
      if (canonicalJson(storeRoute) !== canonicalJson(current.storeRoute)) {
        throw new ProjectBindingError("STORE_ROUTE_INVALID", { reason: "ROUTE_CHANGED" });
      }

      const manifestInspection = this.#dependencies.manifestRepository.inspect(storeRoute, {
        projectId: descriptor.projectId,
        vaultId: descriptor.vaultId,
        storeId: current.storeId,
      });
      if (manifestInspection.status === "missing") {
        if (!this.#dependencies.pathExists(storeRoute.eventsPath)) {
          throw new ProjectBindingError("STORE_UNAVAILABLE", { reason: "DATABASE_MISSING" });
        }
        try {
          await this.#dependencies.identityProbe.verify(storeRoute, {
            projectId: current.projectId,
            vaultId: current.vaultId,
            storeId: current.storeId,
          });
          this.assertRevalidationCurrent(revision, current);
        } catch (error) {
          throw probeError(error);
        }
        throw new ProjectBindingError("STORE_MANIFEST_RECOVERY_REQUIRED");
      }
      if (manifestInspection.status === "invalid") {
        throw new ProjectBindingError(
          manifestIssueCode(manifestInspection.issues) ?? "STORE_UNAVAILABLE",
        );
      }
      const storeManifest = manifestInspection.manifest;
      validateManifestIdentity(storeManifest, descriptor);
      if (storeManifest.storeId !== current.storeId) {
        throw new ProjectBindingError("STORE_ID_MISMATCH");
      }
      if (immutableManifestFingerprint(storeManifest) !== baseline.manifest) {
        throw new ProjectBindingError("STORE_UNAVAILABLE", { reason: "MANIFEST_CHANGED" });
      }
      if (!this.#dependencies.pathExists(storeRoute.eventsPath)) {
        throw new ProjectBindingError("STORE_UNAVAILABLE", { reason: "DATABASE_MISSING" });
      }

      try {
        await this.#dependencies.identityProbe.verify(storeRoute, {
          projectId: descriptor.projectId,
          vaultId: descriptor.vaultId,
          storeId: storeManifest.storeId,
        });
        this.assertRevalidationCurrent(revision, current);
      } catch (error) {
        throw probeError(error);
      }

      const observed: Omit<
        ProjectBinding,
        "contextFingerprint" | "projectBindingId" | "establishedAt"
      > = {
        generation: current.generation,
        source: current.source,
        projectId: descriptor.projectId,
        vaultId: descriptor.vaultId,
        storeId: storeManifest.storeId,
        workspaceId: workspace.workspaceId,
        clientNamespace: current.clientNamespace,
        clientInstanceId: current.clientInstanceId,
        actorRole: current.actorRole,
        projectRoot,
        vaultRoot,
        descriptorPath: descriptorInspection.path,
        storeRoute: { ...storeRoute },
        workspace: { ...workspace },
      };
      if (computeProjectContextFingerprint(observed) !== current.contextFingerprint) {
        throw new ProjectBindingError("PROJECT_BINDING_REQUIRED", { reason: "FINGERPRINT_MISMATCH" });
      }
      const checkedAt = this.#dependencies.now();
      this.assertRevalidationCurrent(revision, current);
      return {
        binding: current,
        workspace: current.workspace,
        checkedAt,
      };
    } catch (error) {
      this.invalidateIfOwned(revision);
      throw new ProjectBindingError(safeCaughtFailureCode(error));
    }
  }

  private resolutionFromError(error: unknown, revision: bigint): ProjectBindingFailure {
    this.clearEstablishmentIfOwned(revision);
    return failure(safeCaughtFailureCode(error));
  }

  private beginEstablishment(): bigint {
    this.#revision += 1n;
    this.#binding = null;
    this.#baseline = null;
    return this.#revision;
  }

  private assertEstablishmentOwned(revision: bigint): void {
    if (this.#revision !== revision) {
      throw new ProjectBindingError("PROJECT_BINDING_REQUIRED", { reason: "SUPERSEDED" });
    }
  }

  private assertRevalidationCurrent(
    revision: bigint,
    binding: ProjectBinding,
  ): void {
    if (this.#revision !== revision || this.#binding !== binding || this.#baseline === null) {
      throw new ProjectBindingError("PROJECT_BINDING_REQUIRED", { reason: "SUPERSEDED" });
    }
  }

  private clearEstablishmentIfOwned(revision: bigint): void {
    if (this.#revision !== revision) return;
    this.#binding = null;
    this.#baseline = null;
  }

  private invalidateIfOwned(revision: bigint): void {
    if (this.#revision !== revision) return;
    this.#revision += 1n;
    this.#binding = null;
    this.#baseline = null;
  }
}
