import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, it } from "node:test";
import * as modelSchemas from "../src/schemas/memory.js";
import type {
  GitWorkspaceSnapshot,
  ProjectBinding,
  ProjectDescriptorV1,
  ProjectId,
  ProjectStoreRoute,
  StoreId,
  VaultId,
  WorkspaceSnapshot,
} from "../src/orchestrator/identity/contracts.js";
import {
  deriveGitWorkspaceId,
  deriveNonGitWorkspaceId,
  GitWorkspaceResolutionError,
} from "../src/orchestrator/identity/git-workspace.resolver.js";
import {
  computeProjectContextFingerprint,
  ProjectBindingError,
  ProjectBindingService,
  type ProjectBindingServiceDependencies,
  type ProjectStoreIdentityProbe,
} from "../src/orchestrator/identity/project-binding.service.js";
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";
import type { StoreManifestV1 } from "../src/orchestrator/identity/store-manifest.schema.js";
import {
  ProjectStatusService,
  type HeuristicProjectCandidate,
} from "../src/orchestrator/diagnostics/project-status.service.js";
import { canonicalMkdtemp } from "./support/canonical-temp.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111" as ProjectId;
const OTHER_PROJECT_ID = "22222222-2222-4222-8222-222222222222" as ProjectId;
const VAULT_ID = "33333333-3333-4333-8333-333333333333" as VaultId;
const OTHER_VAULT_ID = "44444444-4444-4444-8444-444444444444" as VaultId;
const STORE_ID = "55555555-5555-4555-8555-555555555555" as StoreId;
const OTHER_STORE_ID = "66666666-6666-4666-8666-666666666666" as StoreId;
const NOW = "2026-07-13T01:02:03.000Z";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoots(): { root: string; projectRoot: string; vaultRoot: string } {
  const root = canonicalMkdtemp("project-binding-");
  roots.push(root);
  const projectRoot = resolve(root, "project");
  const vaultRoot = resolve(projectRoot, "memory");
  mkdirSync(vaultRoot, { recursive: true });
  return { root, projectRoot, vaultRoot };
}

function descriptor(overrides: Partial<ProjectDescriptorV1> = {}): ProjectDescriptorV1 {
  return {
    schemaVersion: 1,
    projectId: PROJECT_ID,
    vaultId: VAULT_ID,
    createdAt: "2026-07-11T00:00:00Z",
    ...overrides,
  };
}

function manifest(overrides: Partial<StoreManifestV1> = {}): StoreManifestV1 {
  return {
    schemaVersion: 1,
    storeId: STORE_ID,
    projectId: PROJECT_ID,
    vaultId: VAULT_ID,
    createdAt: "2026-07-11T00:00:00Z",
    lastIntegrity: { status: "never" },
    ...overrides,
  };
}

function route(vaultRoot: string, workspace: WorkspaceSnapshot): ProjectStoreRoute {
  const storeRoot = workspace.kind === "git"
    ? resolve(workspace.gitCommonDir, "project-memory", PROJECT_ID, "v2")
    : resolve(vaultRoot, ".memory-mcp", "v2");
  return {
    kind: workspace.kind === "git" ? "git-common" : "vault-local",
    storeRoot,
    eventsPath: join(storeRoot, "events.sqlite"),
    storeManifestPath: join(storeRoot, "store-manifest.json"),
    projectionManifestPath: join(storeRoot, "current-projection.json"),
  };
}

function request(projectRoot: string, vaultRoot: string) {
  return {
    source: "explicit-cli" as const,
    projectRoot,
    vaultRoot,
    clientNamespace: "codex",
    clientInstanceId: "client-1",
    actorRole: "primary" as const,
    generation: 1,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((resolveValue, rejectValue) => {
    resolvePromise = resolveValue;
    rejectPromise = rejectValue;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

interface Fixture {
  root: string;
  projectRoot: string;
  vaultRoot: string;
  calls: string[];
  state: {
    descriptorInspection:
      | { status: "valid"; path: string; descriptor: ProjectDescriptorV1 }
      | { status: "missing"; path: string }
      | { status: "invalid"; path: string; issues: string[] };
    workspace: WorkspaceSnapshot;
    route: ProjectStoreRoute;
    manifestInspection:
      | { status: "valid"; path: string; manifest: StoreManifestV1 }
      | { status: "missing"; path: string }
      | { status: "invalid"; path: string; issues: string[] };
    probeError: Error | null;
  };
  probe: ProjectStoreIdentityProbe;
  dependencies: ProjectBindingServiceDependencies;
  service: ProjectBindingService;
}

function fixture(options: { database?: boolean; workspace?: WorkspaceSnapshot } = {}): Fixture {
  const { root, projectRoot, vaultRoot } = tempRoots();
  const calls: string[] = [];
  const projectDescriptor = descriptor();
  const workspace = options.workspace ?? {
    kind: "non-git" as const,
    workspaceRoot: projectRoot,
    workspaceId: deriveNonGitWorkspaceId(PROJECT_ID, VAULT_ID),
  };
  const storeRoute = route(vaultRoot, workspace);
  const descriptorPath = join(vaultRoot, ".memory-mcp", "project-identity.json");
  mkdirSync(join(vaultRoot, ".memory-mcp"), { recursive: true });
  mkdirSync(storeRoute.storeRoot, { recursive: true });
  writeFileSync(descriptorPath, "fixture", "utf8");
  writeFileSync(storeRoute.storeManifestPath, "fixture", "utf8");
  if (options.database !== false) writeFileSync(storeRoute.eventsPath, "fixture", "utf8");
  const state: Fixture["state"] = {
    descriptorInspection: {
      status: "valid",
      path: descriptorPath,
      descriptor: projectDescriptor,
    },
    workspace,
    route: storeRoute,
    manifestInspection: {
      status: "valid",
      path: storeRoute.storeManifestPath,
      manifest: manifest(),
    },
    probeError: null,
  };
  const probe: ProjectStoreIdentityProbe = {
    async verify(actualRoute, expected) {
      calls.push("identity-probe");
      assert.deepEqual(actualRoute, state.route);
      assert.deepEqual(expected, {
        projectId: PROJECT_ID,
        vaultId: VAULT_ID,
        storeId: STORE_ID,
      });
      if (state.probeError !== null) throw state.probeError;
    },
    async inspectExisting(actualRoute, expected) {
      calls.push("recovery-identity-probe");
      assert.deepEqual(actualRoute, state.route);
      assert.deepEqual(expected, { projectId: PROJECT_ID, vaultId: VAULT_ID });
      if (state.probeError !== null) throw state.probeError;
      return { projectId: PROJECT_ID, vaultId: VAULT_ID, storeId: STORE_ID };
    },
  };
  const dependencies: ProjectBindingServiceDependencies = {
    identityProbe: probe,
    descriptorRepository: {
      inspect(actualVaultRoot) {
        calls.push("descriptor");
        assert.equal(actualVaultRoot, vaultRoot);
        return state.descriptorInspection;
      },
    },
    workspaceResolver: {
      inspect(actualProjectRoot, actualDescriptor) {
        calls.push("git");
        assert.equal(actualProjectRoot, projectRoot);
        assert.deepEqual(actualDescriptor, state.descriptorInspection.status === "valid"
          ? state.descriptorInspection.descriptor
          : projectDescriptor);
        return state.workspace;
      },
    },
    router: {
      route(actualDescriptor, actualVaultRoot, actualWorkspace) {
        calls.push("route");
        assert.equal(actualVaultRoot, vaultRoot);
        assert.equal(actualDescriptor.projectId, PROJECT_ID);
        assert.deepEqual(actualWorkspace, state.workspace);
        return state.route;
      },
    },
    manifestRepository: {
      inspect(actualRoute, expected) {
        calls.push("manifest");
        assert.deepEqual(actualRoute, state.route);
        assert.equal(expected.projectId, PROJECT_ID);
        assert.equal(expected.vaultId, VAULT_ID);
        if (expected.storeId !== undefined) assert.equal(expected.storeId, STORE_ID);
        return state.manifestInspection;
      },
    },
    now: () => NOW,
    randomId: () => "77777777-7777-4777-8777-777777777777",
  };
  const service = new ProjectBindingService(dependencies);
  return {
    root,
    projectRoot,
    vaultRoot,
    calls,
    state,
    probe,
    dependencies,
    service,
  };
}

async function established(item: Fixture): Promise<ProjectBinding> {
  const resolution = await item.service.establish(request(item.projectRoot, item.vaultRoot));
  if (!resolution.ok) assert.fail(resolution.message);
  assert.equal(resolution.ok, true);
  return resolution.binding;
}

function assertBindingFailure(error: unknown, code: string): boolean {
  assert.ok(error instanceof ProjectBindingError);
  assert.equal(error.code, code);
  return true;
}

describe("ProjectBindingService establishment", () => {
  it("canonicalizes temporary roots before deriving identity-bearing paths", () => {
    const targetRoot = mkdtempSync(join(tmpdir(), "project-binding-canonical-target-"));
    const aliasRoot = `${targetRoot}-alias`;
    roots.push(targetRoot, aliasRoot);
    symlinkSync(targetRoot, aliasRoot, process.platform === "win32" ? "junction" : "dir");
    const previousEnvironment = {
      TMPDIR: process.env.TMPDIR,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
    };

    try {
      process.env.TMPDIR = aliasRoot;
      process.env.TEMP = aliasRoot;
      process.env.TMP = aliasRoot;
      const temporary = tempRoots();
      const canonicalRoot = resolve(realpathSync.native(temporary.root));

      assert.equal(temporary.root, canonicalRoot);
      assert.equal(temporary.projectRoot, resolve(canonicalRoot, "project"));
      assert.equal(temporary.vaultRoot, resolve(canonicalRoot, "project", "memory"));
    } finally {
      for (const [name, value] of Object.entries(previousEnvironment)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("establishes only after the ordered descriptor/Git/route/manifest/worker identity gate", async () => {
    const item = fixture();

    const binding = await established(item);

    assert.deepEqual(item.calls, ["descriptor", "git", "route", "manifest", "identity-probe"]);
    assert.equal(binding.projectId, PROJECT_ID);
    assert.equal(binding.vaultId, VAULT_ID);
    assert.equal(binding.storeId, STORE_ID);
    assert.equal(binding.workspace.workspaceId, binding.workspaceId);
    assert.equal(binding.projectRoot, item.projectRoot);
    assert.equal(binding.vaultRoot, item.vaultRoot);
    assert.equal(binding.contextFingerprint, computeProjectContextFingerprint({
      generation: binding.generation,
      source: binding.source,
      projectId: binding.projectId,
      vaultId: binding.vaultId,
      storeId: binding.storeId,
      workspaceId: binding.workspaceId,
      clientNamespace: binding.clientNamespace,
      clientInstanceId: binding.clientInstanceId,
      actorRole: binding.actorRole,
      projectRoot: binding.projectRoot,
      vaultRoot: binding.vaultRoot,
      descriptorPath: binding.descriptorPath,
      storeRoute: binding.storeRoute,
      workspace: binding.workspace,
    }));
    assert.equal(item.service.current(), binding);
    assert.equal(item.service.require(), binding);
  });

  it("rejects an absent, dynamic, or auto project root before any project dependency", async () => {
    for (const projectRoot of ["", "dynamic", " AUTO "]) {
      const item = fixture();
      const resolution = await item.service.establish({
        ...request(item.projectRoot, item.vaultRoot),
        projectRoot,
      });
      assert.deepEqual(resolution, {
        ok: false,
        code: "PROJECT_ROOT_NOT_EXPLICIT",
        message: "An explicit project root is required",
        details: {},
        remediation: ["supply a literal trusted project root"],
      });
      assert.deepEqual(item.calls, []);
      assert.equal(item.service.current(), null);
    }
  });

  it("maps missing canonical roots without inspecting project identity", async () => {
    const item = fixture();
    const missingProject = join(item.root, "missing-project");
    const projectFailure = await item.service.establish(request(missingProject, item.vaultRoot));
    assert.equal(projectFailure.ok, false);
    if (projectFailure.ok) assert.fail("expected failure");
    assert.equal(projectFailure.code, "PROJECT_ROOT_MISSING");
    assert.deepEqual(item.calls, []);

    const missingVault = join(item.projectRoot, "missing-vault");
    const vaultFailure = await item.service.establish(request(item.projectRoot, missingVault));
    assert.equal(vaultFailure.ok, false);
    if (vaultFailure.ok) assert.fail("expected failure");
    assert.equal(vaultFailure.code, "VAULT_ROOT_MISSING");
    assert.deepEqual(item.calls, []);
  });

  it("returns missing and invalid descriptor failures without creating anything", async () => {
    for (const inspection of [
      { status: "missing" as const, issues: undefined },
      { status: "invalid" as const, issues: ["schemaVersion: invalid"] },
    ]) {
      const item = fixture({ database: false });
      const descriptorPath = join(item.vaultRoot, ".memory-mcp", "project-identity.json");
      item.state.descriptorInspection = inspection.status === "missing"
        ? { status: "missing", path: descriptorPath }
        : { status: "invalid", path: descriptorPath, issues: inspection.issues };
      rmSync(descriptorPath, { force: true });
      const before = existsSync(item.state.route.eventsPath);

      const resolution = await item.service.establish(request(item.projectRoot, item.vaultRoot));

      assert.equal(resolution.ok, false);
      if (resolution.ok) assert.fail("expected failure");
      assert.equal(
        resolution.code,
        inspection.status === "missing" ? "PROJECT_DESCRIPTOR_MISSING" : "PROJECT_DESCRIPTOR_INVALID",
      );
      assert.deepEqual(item.calls, ["descriptor"]);
      assert.equal(existsSync(item.state.route.eventsPath), before);
      assert.equal(existsSync(descriptorPath), false);
    }
  });

  it("rejects a descriptor authority path redirected through an external reparse point", async () => {
    const item = fixture();
    const descriptorDirectory = join(item.vaultRoot, ".memory-mcp");
    rmSync(descriptorDirectory, { recursive: true, force: true });
    const externalDirectory = join(item.root, "external-descriptor-authority");
    mkdirSync(externalDirectory);
    writeFileSync(join(externalDirectory, "project-identity.json"), "fixture", "utf8");
    symlinkSync(
      externalDirectory,
      descriptorDirectory,
      process.platform === "win32" ? "junction" : "dir",
    );

    const result = await item.service.establish(request(item.projectRoot, item.vaultRoot));

    assert.equal(result.ok, false);
    if (result.ok) assert.fail("expected failure");
    assert.equal(result.code, "PROJECT_DESCRIPTOR_INVALID");
    assert.deepEqual(item.calls, ["descriptor"]);
  });

  it("rejects a descriptor authority removed after a valid inspection", async () => {
    const item = fixture();
    const descriptorPath = item.state.descriptorInspection.path;
    const repository = item.dependencies.descriptorRepository!;
    const service = new ProjectBindingService({
      ...item.dependencies,
      descriptorRepository: {
        inspect(vaultRoot) {
          const inspection = repository.inspect(vaultRoot);
          rmSync(descriptorPath, { force: true });
          return inspection;
        },
      },
    });

    const result = await service.establish(request(item.projectRoot, item.vaultRoot));

    assert.equal(result.ok, false);
    if (result.ok) assert.fail("expected failure");
    assert.equal(result.code, "PROJECT_DESCRIPTOR_INVALID");
    assert.deepEqual(item.calls, ["descriptor"]);
  });

  it("requires an explicit replica decision when both manifest and database are absent", async () => {
    const item = fixture({ database: false });
    item.state.manifestInspection = { status: "missing", path: item.state.route.storeManifestPath };
    rmSync(item.state.route.storeManifestPath, { force: true });

    const resolution = await item.service.establish(request(item.projectRoot, item.vaultRoot));

    assert.equal(resolution.ok, false);
    if (resolution.ok) assert.fail("expected failure");
    assert.equal(resolution.code, "PROJECT_REPLICA_DECISION_REQUIRED");
    assert.deepEqual(resolution.remediation, [
      "run orchestrator-init --replica initialize-local --apply",
      "or attach/import an existing replica",
      "or explicitly fork as a new project",
    ]);
    assert.deepEqual(item.calls, ["descriptor", "git", "route", "manifest"]);
    assert.equal(existsSync(item.state.route.eventsPath), false);
  });

  it("requires nonmutating CLI recovery when a database exists without its manifest", async () => {
    const item = fixture();
    item.state.manifestInspection = { status: "missing", path: item.state.route.storeManifestPath };
    rmSync(item.state.route.storeManifestPath, { force: true });
    const before = readFileSync(item.state.route.eventsPath);

    const resolution = await item.service.establish(request(item.projectRoot, item.vaultRoot));

    assert.equal(resolution.ok, false);
    if (resolution.ok) assert.fail("expected failure");
    assert.equal(resolution.code, "STORE_MANIFEST_RECOVERY_REQUIRED");
    assert.deepEqual(resolution.remediation, ["run orchestrator-init --apply to verify and recover the manifest"]);
    assert.deepEqual(item.calls, ["descriptor", "git", "route", "manifest", "recovery-identity-probe"]);
    assert.deepEqual(readFileSync(item.state.route.eventsPath), before);
  });

  it("does not label a missing-manifest database recoverable when its worker identity mismatches", async () => {
    for (const code of ["PROJECT_ID_MISMATCH", "VAULT_ID_MISMATCH", "STORE_ID_MISMATCH"] as const) {
      const item = fixture();
      item.state.manifestInspection = {
        status: "missing",
        path: item.state.route.storeManifestPath,
      };
      rmSync(item.state.route.storeManifestPath, { force: true });
      item.state.probeError = new ProjectBindingError(code);

      const resolution = await item.service.establish(request(item.projectRoot, item.vaultRoot));

      assert.equal(resolution.ok, false);
      if (resolution.ok) assert.fail("expected failure");
      assert.equal(resolution.code, code);
      assert.deepEqual(item.calls, [
        "descriptor",
        "git",
        "route",
        "manifest",
        "recovery-identity-probe",
      ]);
      assert.equal(item.service.current(), null);
    }
  });

  it("maps descriptor/manifest/project_meta identity mismatches to typed fail-closed codes", async () => {
    const manifestCases = [
      ["STORE_MANIFEST_PROJECT_ID_MISMATCH", "PROJECT_ID_MISMATCH"],
      ["STORE_MANIFEST_VAULT_ID_MISMATCH", "VAULT_ID_MISMATCH"],
      ["STORE_MANIFEST_STORE_ID_MISMATCH", "STORE_ID_MISMATCH"],
    ] as const;
    for (const [issue, expected] of manifestCases) {
      const item = fixture();
      item.state.manifestInspection = {
        status: "invalid",
        path: item.state.route.storeManifestPath,
        issues: [issue],
      };
      const result = await item.service.establish(request(item.projectRoot, item.vaultRoot));
      assert.equal(result.ok, false);
      if (result.ok) assert.fail("expected failure");
      assert.equal(result.code, expected);
      assert.equal(item.calls.includes("identity-probe"), false);
    }

    for (const code of ["PROJECT_ID_MISMATCH", "VAULT_ID_MISMATCH", "STORE_ID_MISMATCH"] as const) {
      const item = fixture();
      item.state.probeError = new ProjectBindingError(code);
      const result = await item.service.establish(request(item.projectRoot, item.vaultRoot));
      assert.equal(result.ok, false);
      if (result.ok) assert.fail("expected failure");
      assert.equal(result.code, code);
      assert.equal(item.calls.at(-1), "identity-probe");
      assert.equal(item.service.current(), null);
    }
  });

  it("fails closed when a valid manifest names no existing database", async () => {
    const item = fixture({ database: false });
    const result = await item.service.establish(request(item.projectRoot, item.vaultRoot));
    assert.equal(result.ok, false);
    if (result.ok) assert.fail("expected failure");
    assert.equal(result.code, "STORE_UNAVAILABLE");
    assert.deepEqual(item.calls, ["descriptor", "git", "route", "manifest"]);
  });

  it("rejects noncanonical routed paths before manifest inspection or a worker probe", async () => {
    const item = fixture();
    const escapedStoreRoot = `${join(item.root, "store")}${sep}..${sep}escaped-store`;
    item.state.route = {
      ...item.state.route,
      storeRoot: escapedStoreRoot,
      eventsPath: `${escapedStoreRoot}${sep}events.sqlite`,
      storeManifestPath: `${escapedStoreRoot}${sep}store-manifest.json`,
      projectionManifestPath: `${escapedStoreRoot}${sep}current-projection.json`,
    };

    const result = await item.service.establish(request(item.projectRoot, item.vaultRoot));

    assert.equal(result.ok, false);
    if (result.ok) assert.fail("expected failure");
    assert.equal(result.code, "STORE_ROUTE_INVALID");
    assert.deepEqual(item.calls, ["descriptor", "git", "route"]);
  });

  it("rejects a self-consistent absolute store route outside the identity-derived location", async () => {
    const item = fixture();
    const unrelatedStoreRoot = resolve(item.root, "self-consistent-unrelated-store");
    item.state.route = {
      kind: "vault-local",
      storeRoot: unrelatedStoreRoot,
      eventsPath: join(unrelatedStoreRoot, "events.sqlite"),
      storeManifestPath: join(unrelatedStoreRoot, "store-manifest.json"),
      projectionManifestPath: join(unrelatedStoreRoot, "current-projection.json"),
    };
    mkdirSync(unrelatedStoreRoot, { recursive: true });
    writeFileSync(item.state.route.eventsPath, "fixture", "utf8");
    item.state.manifestInspection = {
      status: "valid",
      path: item.state.route.storeManifestPath,
      manifest: manifest(),
    };

    const result = await item.service.establish(request(item.projectRoot, item.vaultRoot));

    assert.equal(result.ok, false);
    if (result.ok) assert.fail("expected failure");
    assert.equal(result.code, "STORE_ROUTE_INVALID");
    assert.deepEqual(item.calls, ["descriptor", "git", "route"]);
  });

  it("rejects a manifest authority reparse point before manifest inspection", async () => {
    const item = fixture();
    const externalDirectory = join(item.root, "external-manifest-authority");
    mkdirSync(externalDirectory);
    rmSync(item.state.route.storeManifestPath, { force: true });
    symlinkSync(
      externalDirectory,
      item.state.route.storeManifestPath,
      process.platform === "win32" ? "junction" : "dir",
    );

    const result = await item.service.establish(request(item.projectRoot, item.vaultRoot));

    assert.equal(result.ok, false);
    if (result.ok) assert.fail("expected failure");
    assert.equal(result.code, "STORE_ROUTE_INVALID");
    assert.deepEqual(item.calls, ["descriptor", "git", "route"]);
  });

  it("rejects a manifest authority removed after a valid inspection", async () => {
    const item = fixture();
    const repository = item.dependencies.manifestRepository!;
    const service = new ProjectBindingService({
      ...item.dependencies,
      manifestRepository: {
        inspect(storeRoute, expected) {
          const inspection = repository.inspect(storeRoute, expected);
          rmSync(storeRoute.storeManifestPath, { force: true });
          return inspection;
        },
      },
    });

    const result = await service.establish(request(item.projectRoot, item.vaultRoot));

    assert.equal(result.ok, false);
    if (result.ok) assert.fail("expected failure");
    assert.equal(result.code, "STORE_ROUTE_INVALID");
    assert.deepEqual(item.calls, ["descriptor", "git", "route", "manifest"]);
  });

  it("maps all Git probe failure reasons without silently treating them as non-Git", async () => {
    const reasons = [
      "COMMAND_FAILED",
      "MALFORMED_OUTPUT",
      "PATH_CANONICALIZATION_FAILED",
      "UNEXPECTED_STDERR",
      "GIT_DIR_OUTSIDE_COMMON_DIR",
    ] as const;
    for (const reason of reasons) {
      const item = fixture();
      item.dependencies.workspaceResolver = {
        inspect() {
          item.calls.push("git");
          throw new GitWorkspaceResolutionError("GIT_PROBE_FAILED", reason);
        },
      };
      const service = new ProjectBindingService(item.dependencies);
      const result = await service.establish(request(item.projectRoot, item.vaultRoot));
      assert.equal(result.ok, false);
      if (result.ok) assert.fail("expected failure");
      assert.equal(result.code, "GIT_PROBE_FAILED");
      assert.deepEqual(item.calls, ["descriptor", "git"]);
    }
  });

  it("contains unknown late establishment failures as typed safe resolutions", async () => {
    for (const [name, override] of [
      ["randomId", { randomId: () => { throw new Error("RANDOM_ID_SECRET"); } }],
      ["now", { now: () => { throw new Error("CLOCK_SECRET"); } }],
      ["pathExists", { pathExists: () => { throw new Error("PATH_PROBE_SECRET"); } }],
    ] as const) {
      const item = fixture();
      const service = new ProjectBindingService({ ...item.dependencies, ...override });

      const resolution = await service.establish(request(item.projectRoot, item.vaultRoot));

      assert.equal(resolution.ok, false, name);
      if (resolution.ok) assert.fail(`expected ${name} failure`);
      assert.equal(service.current(), null, name);
      const encoded = JSON.stringify(resolution);
      assert.equal(encoded.includes("SECRET"), false, name);
      assert.match(resolution.code, /^(?:STORE_ROUTE_INVALID|STORE_UNAVAILABLE)$/);
    }
  });

  it("never trusts throwing code or details getters on late dependency errors", async () => {
    for (const hostileField of ["code", "details"] as const) {
      const item = fixture();
      const hostile = new ProjectBindingError("STORE_UNAVAILABLE");
      Object.defineProperty(hostile, hostileField, {
        configurable: true,
        get(): never {
          throw new Error(`HOSTILE_${hostileField.toUpperCase()}_GETTER_SECRET`);
        },
      });
      const service = new ProjectBindingService({
        ...item.dependencies,
        randomId: () => { throw hostile; },
      });

      const resolution = await service.establish(request(item.projectRoot, item.vaultRoot));

      assert.equal(resolution.ok, false, hostileField);
      if (resolution.ok) assert.fail(`expected ${hostileField} failure`);
      assert.equal(resolution.code, "STORE_UNAVAILABLE");
      assert.equal(service.current(), null);
      assert.equal(JSON.stringify(resolution).includes("SECRET"), false);
    }
  });

  it("prevents an older establishing generation from superseding a newer completed binding", async () => {
    const item = fixture();
    const firstProbe = deferred<void>();
    let verifies = 0;
    const identityProbe: ProjectStoreIdentityProbe = {
      ...item.probe,
      async verify(actualRoute, expected) {
        verifies += 1;
        if (verifies === 1) await firstProbe.promise;
        return item.probe.verify(actualRoute, expected);
      },
    };
    const service = new ProjectBindingService({ ...item.dependencies, identityProbe });

    const olderPending = service.establish(request(item.projectRoot, item.vaultRoot));
    assert.equal(verifies, 1);
    const newer = await service.establish({
      ...request(item.projectRoot, item.vaultRoot),
      generation: 2,
    });
    if (!newer.ok) assert.fail(newer.message);
    assert.equal(newer.ok, true);

    firstProbe.resolve();
    const older = await olderPending;

    assert.equal(older.ok, false);
    if (older.ok) assert.fail("older generation must be superseded");
    assert.equal(older.code, "PROJECT_BINDING_REQUIRED");
    assert.equal(service.current(), newer.binding);
    assert.equal(service.current()?.generation, 2);
  });

  it("keeps linked worktree store identity shared while preserving distinct stable workspace IDs", async () => {
    const item = fixture();
    const gitCommonDir = resolve(item.root, "repo", ".git");
    const firstGitDir = resolve(gitCommonDir, "worktrees", "first");
    const secondGitDir = resolve(gitCommonDir, "worktrees", "second");
    const firstWorkspace: GitWorkspaceSnapshot = {
      kind: "git",
      worktreeRoot: resolve(item.root, "checkout-first"),
      gitDir: firstGitDir,
      gitCommonDir,
      headCommit: "a".repeat(40),
      branchRef: "refs/heads/first",
      detached: false,
      workspaceId: deriveGitWorkspaceId(PROJECT_ID, gitCommonDir, firstGitDir),
    };
    const secondWorkspace: GitWorkspaceSnapshot = {
      ...firstWorkspace,
      worktreeRoot: resolve(item.root, "checkout-second"),
      gitDir: secondGitDir,
      branchRef: "refs/heads/second",
      workspaceId: deriveGitWorkspaceId(PROJECT_ID, gitCommonDir, secondGitDir),
    };
    item.state.workspace = firstWorkspace;
    item.state.route = route(item.vaultRoot, firstWorkspace);
    mkdirSync(item.state.route.storeRoot, { recursive: true });
    writeFileSync(item.state.route.eventsPath, "fixture", "utf8");
    writeFileSync(item.state.route.storeManifestPath, "fixture", "utf8");
    item.state.manifestInspection = {
      status: "valid",
      path: item.state.route.storeManifestPath,
      manifest: manifest(),
    };
    const first = await established(item);

    const secondFixture = fixture({ workspace: secondWorkspace });
    const second = await established(secondFixture);

    assert.equal(first.storeId, second.storeId);
    assert.equal(first.storeRoute.eventsPath, second.storeRoute.eventsPath);
    assert.notEqual(first.workspaceId, second.workspaceId);
    assert.equal(first.workspaceId, deriveGitWorkspaceId(PROJECT_ID, gitCommonDir, firstGitDir));
    assert.equal(second.workspaceId, deriveGitWorkspaceId(PROJECT_ID, gitCommonDir, secondGitDir));
  });
});

describe("ProjectBindingService revalidation", () => {
  it("repeats the complete identity gate and recomputes the private fingerprint", async () => {
    const item = fixture();
    const binding = await established(item);
    item.calls.splice(0);

    const context = await item.service.revalidate(binding);

    assert.deepEqual(item.calls, ["descriptor", "git", "route", "manifest", "identity-probe"]);
    assert.equal(context.binding.contextFingerprint, binding.contextFingerprint);
    assert.equal(context.binding.workspaceId, context.workspace.workspaceId);
    assert.equal(context.checkedAt, NOW);

    const forged = { ...binding, contextFingerprint: "0".repeat(64) };
    await assert.rejects(
      item.service.revalidate(forged),
      (error) => assertBindingFailure(error, "PROJECT_BINDING_REQUIRED"),
    );
  });

  it("keeps revalidation valid when recordIntegrity changes only mutable manifest status", async () => {
    const item = fixture();
    const binding = await established(item);
    item.state.manifestInspection = {
      status: "valid",
      path: binding.storeRoute.storeManifestPath,
      manifest: manifest({
        lastIntegrity: {
          status: "passed",
          checkedAt: "2026-07-13T02:01:00.000Z",
          schemaFingerprint: "a".repeat(64),
          terminalEventHash: "b".repeat(64),
        },
      }),
    };

    const context = await item.service.revalidate(binding);

    assert.equal(context.binding, binding);
    assert.equal(item.service.current(), binding);
  });

  it("still rejects immutable manifest metadata drift after an integrity update", async () => {
    const item = fixture();
    const binding = await established(item);
    item.state.manifestInspection = {
      status: "valid",
      path: binding.storeRoute.storeManifestPath,
      manifest: manifest({
        createdAt: "2026-07-13T02:02:00.000Z",
        lastIntegrity: {
          status: "passed",
          checkedAt: "2026-07-13T02:01:00.000Z",
          schemaFingerprint: "a".repeat(64),
          terminalEventHash: "b".repeat(64),
        },
      }),
    };

    await assert.rejects(
      item.service.revalidate(binding),
      (error) => assertBindingFailure(error, "STORE_UNAVAILABLE"),
    );
  });

  it("rejects a paused stale revalidation after rebind without clearing the newer generation", async () => {
    const item = fixture();
    const oldRevalidationProbe = deferred<void>();
    let verifies = 0;
    const identityProbe: ProjectStoreIdentityProbe = {
      ...item.probe,
      async verify(actualRoute, expected) {
        verifies += 1;
        if (verifies === 2) await oldRevalidationProbe.promise;
        return item.probe.verify(actualRoute, expected);
      },
    };
    const service = new ProjectBindingService({ ...item.dependencies, identityProbe });
    const firstResolution = await service.establish(request(item.projectRoot, item.vaultRoot));
    if (!firstResolution.ok) assert.fail(firstResolution.message);
    assert.equal(firstResolution.ok, true);

    const stalePending = service.revalidate(firstResolution.binding);
    assert.equal(verifies, 2);
    const newer = await service.establish({
      ...request(item.projectRoot, item.vaultRoot),
      generation: 2,
    });
    if (!newer.ok) assert.fail(newer.message);
    assert.equal(newer.ok, true);

    oldRevalidationProbe.resolve();
    await assert.rejects(
      stalePending,
      (error) => assertBindingFailure(error, "PROJECT_BINDING_REQUIRED"),
    );
    assert.equal(service.current(), newer.binding);
    assert.equal(service.current()?.generation, 2);
  });

  it("worker-verifies the known store identity before reporting a disappeared manifest as recoverable", async () => {
    const item = fixture();
    const binding = await established(item);
    item.calls.splice(0);
    item.state.manifestInspection = {
      status: "missing",
      path: binding.storeRoute.storeManifestPath,
    };
    rmSync(binding.storeRoute.storeManifestPath, { force: true });
    item.state.probeError = new ProjectBindingError("PROJECT_ID_MISMATCH");

    await assert.rejects(
      item.service.revalidate(binding),
      (error) => assertBindingFailure(error, "PROJECT_ID_MISMATCH"),
    );
    assert.deepEqual(item.calls, ["descriptor", "git", "route", "manifest", "identity-probe"]);
  });

  it("reconstructs genuine late ProjectBindingError objects without touching hostile public getters", async () => {
    const item = fixture();
    const originalManifestRepository = item.dependencies.manifestRepository!;
    const hostile = new ProjectBindingError("STORE_ROUTE_INVALID", {
      secret: "HOSTILE_BINDING_DETAILS_SECRET",
    });
    Object.defineProperties(hostile, {
      code: {
        configurable: true,
        enumerable: true,
        get(): never {
          throw new Error("HOSTILE_BINDING_CODE_GETTER_SECRET");
        },
      },
      details: {
        configurable: true,
        enumerable: true,
        get(): never {
          throw new Error("HOSTILE_BINDING_DETAILS_GETTER_SECRET");
        },
      },
    });
    let rejectRevalidation = false;
    const service = new ProjectBindingService({
      ...item.dependencies,
      manifestRepository: {
        inspect(actualRoute, expected) {
          if (rejectRevalidation) throw hostile;
          return originalManifestRepository.inspect(actualRoute, expected);
        },
      },
    });
    const resolution = await service.establish(request(item.projectRoot, item.vaultRoot));
    if (!resolution.ok) assert.fail(resolution.message);
    rejectRevalidation = true;

    let caught: unknown;
    try {
      await service.revalidate(resolution.binding);
    } catch (error) {
      caught = error;
    }

    assert.ok(caught instanceof ProjectBindingError);
    assert.doesNotThrow(() => JSON.stringify(caught));
    assert.notStrictEqual(caught, hostile);
    assert.equal(caught.code, "STORE_ROUTE_INVALID");
    assert.deepEqual(caught.details, {});
    assert.equal(JSON.stringify(caught).includes("SECRET"), false);
  });

  it("fails rather than following descriptor, manifest, branch, common-dir, or generation drift", async () => {
    const changes: Array<{
      name: string;
      mutate(item: Fixture, binding: ProjectBinding): ProjectBinding;
      code: string;
    }> = [
      {
        name: "descriptor",
        mutate(item, binding) {
          item.state.descriptorInspection = {
            status: "valid",
            path: binding.descriptorPath,
            descriptor: descriptor({ projectId: OTHER_PROJECT_ID }),
          };
          return binding;
        },
        code: "PROJECT_ID_MISMATCH",
      },
      {
        name: "manifest",
        mutate(item, binding) {
          item.state.manifestInspection = {
            status: "valid",
            path: binding.storeRoute.storeManifestPath,
            manifest: manifest({ storeId: OTHER_STORE_ID }),
          };
          return binding;
        },
        code: "STORE_ID_MISMATCH",
      },
      {
        name: "branch",
        mutate(item, binding) {
          assert.equal(item.state.workspace.kind, "git");
          item.state.workspace = { ...item.state.workspace, branchRef: "refs/heads/other" };
          return binding;
        },
        code: "WORKSPACE_AMBIGUOUS",
      },
      {
        name: "git common directory",
        mutate(item, binding) {
          assert.equal(item.state.workspace.kind, "git");
          const gitCommonDir = resolve(item.root, "moved", ".git");
          const gitDir = resolve(gitCommonDir, "worktrees", "bound");
          item.state.workspace = {
            ...item.state.workspace,
            gitCommonDir,
            gitDir,
            workspaceId: deriveGitWorkspaceId(PROJECT_ID, gitCommonDir, gitDir),
          };
          return binding;
        },
        code: "WORKSPACE_AMBIGUOUS",
      },
      {
        name: "head commit",
        mutate(item, binding) {
          assert.equal(item.state.workspace.kind, "git");
          item.state.workspace = { ...item.state.workspace, headCommit: "b".repeat(40) };
          return binding;
        },
        code: "WORKSPACE_AMBIGUOUS",
      },
      {
        name: "generation",
        mutate(_item, binding) {
          return { ...binding, generation: binding.generation + 1 };
        },
        code: "PROJECT_BINDING_REQUIRED",
      },
    ];

    for (const change of changes) {
      const item = fixture();
      if (
        change.name === "branch"
        || change.name === "git common directory"
        || change.name === "head commit"
      ) {
        const gitCommonDir = resolve(item.root, "repo", ".git");
        const gitDir = resolve(gitCommonDir, "worktrees", "bound");
        item.state.workspace = {
          kind: "git",
          worktreeRoot: item.projectRoot,
          gitDir,
          gitCommonDir,
          headCommit: "a".repeat(40),
          branchRef: "refs/heads/main",
          detached: false,
          workspaceId: deriveGitWorkspaceId(PROJECT_ID, gitCommonDir, gitDir),
        };
        item.state.route = route(item.vaultRoot, item.state.workspace);
        mkdirSync(item.state.route.storeRoot, { recursive: true });
        writeFileSync(item.state.route.eventsPath, "fixture", "utf8");
        writeFileSync(item.state.route.storeManifestPath, "fixture", "utf8");
        item.state.manifestInspection = {
          status: "valid",
          path: item.state.route.storeManifestPath,
          manifest: manifest(),
        };
      }
      const binding = await established(item);
      const changedBinding = change.mutate(item, binding);
      await assert.rejects(
        item.service.revalidate(changedBinding),
        (error) => assertBindingFailure(error, change.code),
        change.name,
      );
      assert.equal(item.service.current(), null);
    }
  });
});

describe("ProjectStatusService privacy", () => {
  it("labels heuristic candidates as diagnostics and never lets them replace the explicit binding", async () => {
    const item = fixture();
    const binding = await established(item);
    const candidate = {
      label: "heuristic" as const,
      projectRoot: resolve(item.root, "other-project"),
      vaultRoot: resolve(item.root, "other-project", "memory"),
      projectId: OTHER_PROJECT_ID,
      vaultId: OTHER_VAULT_ID,
      reason: "recent IDE folder",
      content: "must never appear",
      contextFingerprint: "must never appear",
      capabilityToken: "must never appear",
    } as HeuristicProjectCandidate & Record<string, unknown>;
    const service = new ProjectStatusService(item.service);

    const status = service.status({
      mode: "primary",
      runtime: {
        ok: true,
        nodeVersion: "24.16.0",
        sqliteVersion: "3.53.0",
        nodeVersionAtLeastMinimum: true,
        sqliteVersionAtLeastMinimum: true,
        nodeSqlite: true,
        wal: true,
        fts5: true,
        sqliteDeserialize: true,
        queryOnly: true,
        foreignKeys: true,
        synchronousFull: true,
        busyTimeoutMs: 5000,
        trustedSchemaOff: true,
        transactionRollback: true,
        applicationId: 0x504d454d,
      },
      heuristicCandidates: [candidate],
    });

    assert.equal(status.state, "bound");
    assert.equal(status.contentAuthorized, true);
    assert.equal(status.project?.projectId, binding.projectId);
    assert.equal(status.heuristicCandidates[0]?.label, "heuristic-unselected");
    assert.equal(status.heuristicCandidates[0]?.projectId, OTHER_PROJECT_ID);
    const encoded = JSON.stringify(status);
    assert.equal(encoded.includes(binding.projectBindingId), false);
    assert.equal(encoded.includes(binding.contextFingerprint), false);
    assert.equal(encoded.includes("must never appear"), false);
    assert.equal(encoded.includes("capabilityToken"), false);
  });

  it("keeps a bound identity not-ready until a complete successful runtime report exists", async () => {
    const item = fixture();
    await established(item);
    const service = new ProjectStatusService(item.service);

    const absent = service.status({ mode: "primary", runtime: null });
    assert.equal(absent.state, "not-ready");
    assert.equal(absent.contentAuthorized, false);
    assert.equal(absent.project, undefined);

    const malformed = service.status({
      mode: "primary",
      runtime: { ok: true, nodeVersion: "RUNTIME_SHAPE_SECRET" } as never,
    });
    assert.equal(malformed.state, "not-ready");
    assert.equal(malformed.contentAuthorized, false);
    assert.equal(JSON.stringify(malformed).includes("RUNTIME_SHAPE_SECRET"), false);
  });

  it("reports a confirmed runtime capability failure as blocked", async () => {
    const item = fixture();
    await established(item);
    const service = new ProjectStatusService(item.service);

    const status = service.status({
      mode: "primary",
      runtime: {
        ok: false,
        code: "SQLITE_CAPABILITY_MISSING",
        message: "safe input must be reconstructed",
        nodeVersion: "24.0.0",
        sqliteVersion: "3.53.0",
        checks: { wal: false },
      },
    });

    assert.equal(status.state, "blocked");
    assert.equal(status.contentAuthorized, false);
    assert.equal(status.project, undefined);
  });

  it("snapshots successful runtime fields once before validating and reporting them", async () => {
    const item = fixture();
    await established(item);
    const service = new ProjectStatusService(item.service);
    const runtimeValues: Record<string, unknown> = {
      ok: true,
      nodeVersion: "24.16.0",
      sqliteVersion: "3.53.0",
      nodeVersionAtLeastMinimum: true,
      sqliteVersionAtLeastMinimum: true,
      nodeSqlite: true,
      wal: true,
      fts5: true,
      sqliteDeserialize: true,
      queryOnly: true,
      foreignKeys: true,
      synchronousFull: true,
      busyTimeoutMs: 5000,
      trustedSchemaOff: true,
      transactionRollback: true,
      applicationId: 0x504d454d,
    };
    const reads: Record<string, number> = {};
    const statefulRuntime: Record<string, unknown> = {};
    for (const [name, safeValue] of Object.entries(runtimeValues)) {
      const validationReads = name === "nodeVersion" || name === "sqliteVersion" ? 2 : 1;
      Object.defineProperty(statefulRuntime, name, {
        enumerable: true,
        get(): unknown {
          reads[name] = (reads[name] ?? 0) + 1;
          return reads[name]! <= validationReads
            ? safeValue
            : `RUNTIME_${name}_GETTER_SECRET`;
        },
      });
    }

    const status = service.status({
      mode: "primary",
      runtime: statefulRuntime as never,
    });

    assert.equal(status.state, "bound");
    assert.equal(status.contentAuthorized, true);
    assert.deepEqual(reads, Object.fromEntries(Object.keys(runtimeValues).map((name) => [name, 1])));
    assert.deepEqual(status.runtime, {
      ok: true,
      nodeVersion: "24.16.0",
      sqliteVersion: "3.53.0",
      nodeSqlite: true,
      wal: true,
      fts5: true,
      sqliteDeserialize: true,
      queryOnly: true,
      foreignKeys: true,
      synchronousFull: true,
      busyTimeoutMs: 5000,
      trustedSchemaOff: true,
      transactionRollback: true,
      applicationId: 0x504d454d,
    });
    assert.equal(JSON.stringify(status).includes("SECRET"), false);
  });

  it("reconstructs failure text locally and allowlists only fixed runtime check names", () => {
    const item = fixture();
    const service = new ProjectStatusService(item.service);
    const status = service.status({
      mode: "primary",
      runtime: {
        ok: false,
        code: "SQLITE_CAPABILITY_MISSING",
        message: "RUNTIME_RAW_SECRET",
        nodeVersion: "24.0.0",
        sqliteVersion: "3.53.0",
        checks: {
          wal: false,
          fts5: true,
          unknownSecretCheck: true,
        },
      },
      failure: {
        ok: false,
        code: "UNKNOWN_ATTACKER_CODE",
        message: "FAILURE_MESSAGE_SECRET",
        details: { secret: "FAILURE_DETAILS_SECRET" },
        remediation: ["FAILURE_REMEDIATION_SECRET"],
      } as never,
    });

    assert.equal(status.state, "blocked");
    assert.equal(status.contentAuthorized, false);
    assert.deepEqual(status.failure, {
      code: "PROJECT_BINDING_REQUIRED",
      message: "A trusted project binding is required",
      remediation: ["establish a new trusted project binding"],
    });
    assert.deepEqual(status.runtime?.checks, { wal: false, fts5: true });
    const encoded = JSON.stringify(status);
    assert.equal(encoded.includes("UNKNOWN_ATTACKER_CODE"), false);
    assert.equal(encoded.includes("SECRET"), false);
  });

  it("fails closed when a malformed runtime report throws while being inspected", () => {
    const item = fixture();
    const service = new ProjectStatusService(item.service);
    const hostileRuntime = Object.defineProperty({ ok: false }, "nodeVersion", {
      enumerable: true,
      get(): never {
        throw new Error("RUNTIME_GETTER_SECRET");
      },
    });

    const status = service.status({
      mode: "primary",
      runtime: hostileRuntime as never,
    });

    assert.equal(status.state, "not-ready");
    assert.equal(status.contentAuthorized, false);
    assert.deepEqual(status.runtime, {
      ok: false,
      code: "SQLITE_CAPABILITY_MISSING",
      nodeVersion: "unknown",
      checks: {},
    });
    assert.equal(JSON.stringify(status).includes("SECRET"), false);
  });

  it("safely allowlists a binding failure whose code getter throws", () => {
    const item = fixture();
    const service = new ProjectStatusService(item.service);
    const hostileFailure = Object.defineProperty({
      ok: false,
      message: "FAILURE_MESSAGE_SECRET",
      details: { secret: "FAILURE_DETAILS_SECRET" },
      remediation: ["FAILURE_REMEDIATION_SECRET"],
    }, "code", {
      enumerable: true,
      get(): never {
        throw new Error("FAILURE_CODE_GETTER_SECRET");
      },
    });

    const status = service.status({
      mode: "primary",
      runtime: null,
      failure: hostileFailure as never,
    });

    assert.equal(status.state, "blocked");
    assert.equal(status.contentAuthorized, false);
    assert.deepEqual(status.failure, {
      code: "PROJECT_BINDING_REQUIRED",
      message: "A trusted project binding is required",
      remediation: ["establish a new trusted project binding"],
    });
    assert.equal(JSON.stringify(status).includes("SECRET"), false);
  });

  it("reports blocked diagnostic candidates without authorizing content", () => {
    const item = fixture();
    const service = new ProjectStatusService(item.service);
    const status = service.status({
      mode: "primary",
      runtime: null,
      failure: {
        ok: false,
        code: "PROJECT_BINDING_REQUIRED",
        message: "No trusted binding",
        details: { secret: "not exported" },
        remediation: ["select an explicit project"],
      },
      heuristicCandidates: [{
        label: "heuristic",
        projectRoot: item.projectRoot,
        reason: "workspace history",
      }],
    });
    assert.equal(status.state, "blocked");
    assert.equal(status.contentAuthorized, false);
    assert.equal(status.failure?.code, "PROJECT_BINDING_REQUIRED");
    assert.equal(JSON.stringify(status).includes("not exported"), false);
  });

  it("never exposes private binding fields through any model-controlled Zod schema", () => {
    for (const [name, schema] of Object.entries(modelSchemas)) {
      if (typeof schema !== "object" || schema === null || !("shape" in schema)) continue;
      const shape = (schema as { shape: Record<string, unknown> }).shape;
      for (const forbidden of [
        "binding",
        "projectBinding",
        "projectBindingId",
        "contextFingerprint",
        "capabilityToken",
      ]) {
        assert.equal(forbidden in shape, false, `${name} exposes ${forbidden}`);
      }
    }
  });
});

describe("computeProjectContextFingerprint", () => {
  it("hashes only canonical private binding material with the versioned domain", () => {
    const item = fixture();
    const workspace = item.state.workspace;
    const input: Omit<ProjectBinding, "contextFingerprint" | "projectBindingId" | "establishedAt"> = {
      generation: 1,
      source: "explicit-cli",
      projectId: PROJECT_ID,
      vaultId: VAULT_ID,
      storeId: STORE_ID,
      workspaceId: workspace.workspaceId,
      clientNamespace: "codex",
      clientInstanceId: "client-1",
      actorRole: "primary",
      projectRoot: item.projectRoot,
      vaultRoot: item.vaultRoot,
      descriptorPath: join(item.vaultRoot, ".memory-mcp", "project-identity.json"),
      storeRoute: item.state.route,
      workspace,
    };
    const expectedMaterial = {
      generation: 1,
      source: "explicit-cli",
      projectId: PROJECT_ID,
      vaultId: VAULT_ID,
      storeId: STORE_ID,
      workspaceId: workspace.workspaceId,
      projectRoot: item.projectRoot,
      vaultRoot: item.vaultRoot,
      descriptorPath: join(item.vaultRoot, ".memory-mcp", "project-identity.json"),
      storeRoute: item.state.route,
      workspace,
      clientNamespace: "codex",
      clientInstanceId: "client-1",
      actorRole: "primary",
    };
    const canonical = canonicalJson(expectedMaterial);
    const expected = createHash("sha256")
      .update(`project-memory/project-context/v1\n${canonical}`, "utf8")
      .digest("hex");

    assert.equal(computeProjectContextFingerprint(input), expected);
  });

  it("binds every authority-bearing route, workspace, source, and descriptor field", () => {
    const item = fixture();
    const gitCommonDir = resolve(item.root, "repo", ".git");
    const gitDir = resolve(gitCommonDir, "worktrees", "bound");
    const workspace: GitWorkspaceSnapshot = {
      kind: "git",
      worktreeRoot: item.projectRoot,
      gitDir,
      gitCommonDir,
      headCommit: "a".repeat(40),
      branchRef: "refs/heads/main",
      detached: false,
      workspaceId: deriveGitWorkspaceId(PROJECT_ID, gitCommonDir, gitDir),
    };
    const storeRoot = resolve(gitCommonDir, "project-memory", PROJECT_ID, "v2");
    const input: Omit<ProjectBinding, "contextFingerprint" | "projectBindingId" | "establishedAt"> = {
      generation: 1,
      source: "explicit-cli",
      projectId: PROJECT_ID,
      vaultId: VAULT_ID,
      storeId: STORE_ID,
      workspaceId: workspace.workspaceId,
      clientNamespace: "codex",
      clientInstanceId: "client-1",
      actorRole: "primary",
      projectRoot: item.projectRoot,
      vaultRoot: item.vaultRoot,
      descriptorPath: join(item.vaultRoot, ".memory-mcp", "project-identity.json"),
      storeRoute: {
        kind: "git-common",
        storeRoot,
        eventsPath: join(storeRoot, "events.sqlite"),
        storeManifestPath: join(storeRoot, "store-manifest.json"),
        projectionManifestPath: join(storeRoot, "current-projection.json"),
      },
      workspace,
    };
    const fingerprint = computeProjectContextFingerprint(input);
    const variants = [
      { ...input, source: "mcp-roots" as const },
      { ...input, descriptorPath: `${input.descriptorPath}.other` },
      {
        ...input,
        storeRoute: {
          ...input.storeRoute,
          projectionManifestPath: `${input.storeRoute.projectionManifestPath}.other`,
        },
      },
      { ...input, workspace: { ...workspace, headCommit: "b".repeat(40) } },
      { ...input, workspace: { ...workspace, branchRef: "refs/heads/other" } },
    ];
    for (const variant of variants) {
      assert.notEqual(computeProjectContextFingerprint(variant), fingerprint);
    }
  });
});
