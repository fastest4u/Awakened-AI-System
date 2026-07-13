import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type {
  ProjectBinding,
  ProjectContext,
} from "../src/orchestrator/identity/contracts.js";
import {
  deriveGitWorkspaceId,
  deriveNonGitWorkspaceId,
} from "../src/orchestrator/identity/git-workspace.resolver.js";
import {
  computeProjectContextFingerprint,
  ProjectBindingError,
} from "../src/orchestrator/identity/project-binding.service.js";
import type { TrustedProjectBindingRequest } from "../src/orchestrator/identity/project-binding.request.js";
import { ProjectDescriptorRepository } from "../src/orchestrator/identity/project-descriptor.repository.js";
import type { IntegrityReport } from "../src/orchestrator/integrity/integrity.types.js";
import type { RuntimeCapabilityReport } from "../src/orchestrator/runtime/runtime-capabilities.js";
import { ProjectStoreWorkerError } from "../src/orchestrator/runtime/project-store-executor.js";
import { WorkerProjectStoreIdentityProbe } from "../src/orchestrator/runtime/project-store-identity-probe.js";
import {
  DefaultProjectStoreBootstrapService,
  type ProjectStoreBootstrapResult,
} from "../src/orchestrator/storage/project-store-bootstrap.service.js";
import { diagnoseMemoryConfig } from "../src/config/memory.config.js";
import {
  projectConfigPath,
  projectConfigSchemaPath,
} from "../src/config/frontmatter.config.js";
import {
  HELP,
  LEGACY_HELP,
  CliUsageError,
  parseCliArgs,
  type CliOptions,
} from "../src/cli/parse-args.js";
import {
  createOrchestratorAdminDependencies,
  createProjectInitializationInspector,
  runCliCommand,
  type CliIo,
  type OrchestratorAdminDependencies,
  type ProjectInitializationInspection,
} from "../src/cli/run-command.js";
import { canonicalMkdtemp } from "./support/canonical-temp.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryProject(): { projectRoot: string; vaultRoot: string } {
  const root = canonicalMkdtemp("memory-cli-admin-");
  temporaryRoots.push(root);
  const projectRoot = resolve(root, "project");
  const vaultRoot = resolve(projectRoot, "memory");
  mkdirSync(vaultRoot, { recursive: true });
  return { projectRoot, vaultRoot };
}

function runGit(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  assert.equal(
    result.status,
    0,
    `${args.join(" ")}: ${result.stderr || result.error?.message || "git command failed"}`,
  );
  return result.stdout.trim();
}

function temporaryGitRepository(): {
  repositoryRoot: string;
  gitDir: string;
  gitCommonDir: string;
  headCommit: string;
  branchRef: string;
} {
  const root = canonicalMkdtemp("memory-cli-admin-git-");
  temporaryRoots.push(root);
  const repositoryRoot = resolve(root, "repository");
  mkdirSync(repositoryRoot, { recursive: true });
  runGit(repositoryRoot, ["init", "--quiet"]);
  runGit(repositoryRoot, ["config", "user.email", "cli-admin@example.invalid"]);
  runGit(repositoryRoot, ["config", "user.name", "CLI Admin Test"]);
  writeFileSync(join(repositoryRoot, "README.md"), "CLI authority fixture\n", "utf8");
  runGit(repositoryRoot, ["add", "README.md"]);
  runGit(repositoryRoot, ["commit", "--quiet", "-m", "initial"]);
  return {
    repositoryRoot,
    gitDir: resolve(runGit(repositoryRoot, [
      "rev-parse", "--path-format=absolute", "--absolute-git-dir",
    ])),
    gitCommonDir: resolve(runGit(repositoryRoot, [
      "rev-parse", "--path-format=absolute", "--git-common-dir",
    ])),
    headCommit: runGit(repositoryRoot, ["rev-parse", "HEAD"]),
    branchRef: runGit(repositoryRoot, ["symbolic-ref", "-q", "HEAD"]),
  };
}

function treeDigest(root: string): string {
  const entries: string[] = [];
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const relativePath = path.slice(root.length).replaceAll("\\", "/");
      const stat = statSync(path);
      if (stat.isDirectory()) {
        entries.push(`d:${relativePath}`);
        visit(path);
      } else {
        entries.push(`f:${relativePath}:${createHash("sha256").update(readFileSync(path)).digest("hex")}`);
      }
    }
  };
  visit(root);
  return createHash("sha256").update(entries.join("\n")).digest("hex");
}

function outputCapture(): {
  io: CliIo;
  stdout: () => string;
  stderr: () => string;
} {
  const out: string[] = [];
  const error: string[] = [];
  return {
    io: {
      stdout: (text: string) => { out.push(text); },
      stderr: (text: string) => { error.push(text); },
    },
    stdout: () => out.join(""),
    stderr: () => error.join(""),
  };
}

const RUNTIME: RuntimeCapabilityReport = {
  nodeVersion: "22.22.3",
  sqliteVersion: "3.51.3",
  nodeVersionAtLeastMinimum: true,
  sqliteVersionAtLeastMinimum: true,
  nodeSqlite: true,
  wal: true,
  fts5: true,
  foreignKeys: true,
  synchronousFull: true,
  busyTimeoutMs: 5000,
  trustedSchemaOff: true,
  transactionRollback: true,
  applicationId: 0x504d454d,
};

function bindingWithFingerprint(
  binding: Omit<ProjectBinding, "contextFingerprint">,
): ProjectBinding {
  const { projectBindingId, establishedAt, ...fingerprintMaterial } = binding;
  return {
    ...binding,
    contextFingerprint: computeProjectContextFingerprint(fingerprintMaterial),
  };
}

function refingerprintBinding(binding: ProjectBinding): ProjectBinding {
  const { contextFingerprint: _contextFingerprint, ...withoutFingerprint } = binding;
  return bindingWithFingerprint(withoutFingerprint);
}

const CONTEXT_PROJECT_ID = "11111111-1111-4111-8111-111111111111" as ProjectBinding["projectId"];
const CONTEXT_VAULT_ID = "22222222-2222-4222-8222-222222222222" as ProjectBinding["vaultId"];
const CONTEXT_WORKSPACE_ID = deriveNonGitWorkspaceId(CONTEXT_PROJECT_ID, CONTEXT_VAULT_ID);
const CONTEXT_BINDING = bindingWithFingerprint({
  projectBindingId: "44444444-4444-4444-8444-444444444444",
  generation: 1,
  source: "explicit-cli",
  projectId: CONTEXT_PROJECT_ID,
  vaultId: CONTEXT_VAULT_ID,
  storeId: "33333333-3333-4333-8333-333333333333" as ProjectBinding["storeId"],
  workspaceId: CONTEXT_WORKSPACE_ID,
  clientNamespace: "memory-vault-cli",
  clientInstanceId: "private-client-id",
  actorRole: "maintenance",
  projectRoot: "C:\\explicit\\project",
  vaultRoot: "C:\\explicit\\project\\memory",
  descriptorPath: "C:\\explicit\\project\\memory\\.memory-mcp\\project-identity.json",
  storeRoute: {
    kind: "vault-local",
    storeRoot: "C:\\explicit\\project\\memory\\.memory-mcp\\v2",
    eventsPath: "C:\\explicit\\project\\memory\\.memory-mcp\\v2\\events.sqlite",
    storeManifestPath: "C:\\explicit\\project\\memory\\.memory-mcp\\v2\\store-manifest.json",
    projectionManifestPath: "C:\\explicit\\project\\memory\\.memory-mcp\\v2\\current-projection.json",
  },
  workspace: {
    kind: "non-git",
    workspaceRoot: "C:\\explicit\\project",
    workspaceId: CONTEXT_WORKSPACE_ID,
  },
  establishedAt: "2026-07-13T00:00:00.000Z",
});
const CONTEXT: ProjectContext = {
  binding: CONTEXT_BINDING,
  workspace: { ...CONTEXT_BINDING.workspace },
  checkedAt: "2026-07-13T00:00:01.000Z",
};

function bindingForRequest(request: TrustedProjectBindingRequest): ProjectBinding {
  const storeRoot = join(request.vaultRoot, ".memory-mcp", "v2");
  return refingerprintBinding({
    ...CONTEXT.binding,
    generation: request.generation,
    source: request.source,
    actorRole: request.actorRole,
    clientNamespace: request.clientNamespace,
    clientInstanceId: request.clientInstanceId,
    projectRoot: request.projectRoot,
    vaultRoot: request.vaultRoot,
    descriptorPath: join(request.vaultRoot, ".memory-mcp", "project-identity.json"),
    storeRoute: {
      kind: "vault-local",
      storeRoot,
      eventsPath: join(storeRoot, "events.sqlite"),
      storeManifestPath: join(storeRoot, "store-manifest.json"),
      projectionManifestPath: join(storeRoot, "current-projection.json"),
    },
    workspace: {
      kind: "non-git",
      workspaceRoot: request.projectRoot,
      workspaceId: CONTEXT.binding.workspaceId,
    },
  });
}

function statusBindingFor(roots: { projectRoot: string; vaultRoot: string }): ProjectBinding {
  return bindingForRequest({
    source: "explicit-cli",
    projectRoot: roots.projectRoot,
    vaultRoot: roots.vaultRoot,
    clientNamespace: "memory-vault-cli",
    clientInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    actorRole: "untrusted",
    generation: 1,
  });
}

function maintenanceBindingFor(roots: { projectRoot: string; vaultRoot: string }): ProjectBinding {
  return bindingForRequest({
    source: "explicit-cli",
    projectRoot: roots.projectRoot,
    vaultRoot: roots.vaultRoot,
    clientNamespace: "memory-vault-cli",
    clientInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    actorRole: "maintenance",
    generation: 1,
  });
}

function contextForBinding(binding: ProjectBinding): ProjectContext {
  return {
    binding,
    workspace: { ...binding.workspace },
    checkedAt: "2026-07-13T00:00:01.000Z",
  };
}

function gitStatusBindingFor(binding: ProjectBinding): ProjectBinding {
  const gitCommonDir = resolve(binding.projectRoot, ".git");
  const gitDir = resolve(gitCommonDir, "worktrees", "fixture");
  const workspaceId = deriveGitWorkspaceId(binding.projectId, gitCommonDir, gitDir);
  const storeRoot = resolve(gitCommonDir, "project-memory", binding.projectId, "v2");
  return refingerprintBinding({
    ...binding,
    workspaceId,
    storeRoute: {
      kind: "git-common",
      storeRoot,
      eventsPath: join(storeRoot, "events.sqlite"),
      storeManifestPath: join(storeRoot, "store-manifest.json"),
      projectionManifestPath: join(storeRoot, "current-projection.json"),
    },
    workspace: {
      kind: "git",
      worktreeRoot: binding.projectRoot,
      gitDir,
      gitCommonDir,
      headCommit: "a".repeat(40),
      branchRef: "refs/heads/main",
      detached: false,
      workspaceId,
    },
  });
}

const QUICK_REPORT: IntegrityReport = {
  ok: true,
  mode: "quick",
  projectId: CONTEXT.binding.projectId,
  storeId: CONTEXT.binding.storeId,
  firstGlobalPosition: "0",
  lastGlobalPosition: "0",
  eventsVerified: 0,
  streamsVerified: 0,
  commandsVerified: 0,
  schemaFingerprint: "a".repeat(64),
  terminalEventHash: "0".repeat(64),
  issues: [],
};

function defaultOptions(command: CliOptions["command"]): CliOptions {
  return {
    command,
    dryRun: true,
    backup: true,
    unsafe: false,
    confirm: false,
    rollback: false,
    format: "text",
    fullIntegrity: false,
    paths: [],
  };
}

function dependencies(overrides: Partial<OrchestratorAdminDependencies> = {}): {
  value: OrchestratorAdminDependencies;
  calls: string[];
} {
  const calls: string[] = [];
  let establishedBinding: ProjectBinding | undefined;
  const value: OrchestratorAdminDependencies = {
    async runtimeProbe() {
      calls.push("runtime");
      return { ok: true, ...RUNTIME };
    },
    async inspectInitialization(projectRoot: string, vaultRoot: string) {
      calls.push(`inspect:${projectRoot}:${vaultRoot}`);
      return {
        state: "new-project",
        summary: { projectRoot, vaultRoot, routeState: "pending-project-identity" },
        remediation: ["rerun with --apply"],
      };
    },
    async inspectWorkspaceAuthority(projectRoot: string, vaultRoot: string) {
      calls.push("authority");
      const binding = establishedBinding ?? maintenanceBindingFor({ projectRoot, vaultRoot });
      return {
        descriptorPath: binding.descriptorPath,
        projectId: binding.projectId,
        vaultId: binding.vaultId,
        storeId: binding.storeId,
        workspaceId: binding.workspaceId,
        storeRoute: { ...binding.storeRoute },
        workspace: { ...binding.workspace },
      };
    },
    bootstrap: {
      async initialize() {
        calls.push("bootstrap");
        throw new Error("bootstrap result must be supplied by the test");
      },
    },
    bindingService: {
      async establish(request: TrustedProjectBindingRequest) {
        calls.push(`establish:${request.actorRole}`);
        establishedBinding = bindingForRequest(request);
        return { ok: true, binding: establishedBinding };
      },
      async revalidate(binding: ProjectBinding) {
        assert.ok(establishedBinding);
        assert.deepEqual(binding, establishedBinding);
        calls.push("revalidate");
        return contextForBinding(establishedBinding);
      },
    },
    executorFactory(context: ProjectContext) {
      assert.ok(establishedBinding);
      assert.deepEqual(context, contextForBinding(establishedBinding));
      calls.push("executor");
      return {
        async open() { calls.push("open"); return {} as never; },
        async quickIntegrity() { calls.push("quick"); return QUICK_REPORT; },
        async fullIntegrity() { calls.push("full"); return { ...QUICK_REPORT, mode: "full" }; },
        async close() { calls.push("close"); },
      };
    },
    integrityRecorder: {
      async record() { calls.push("record"); },
    },
    clientInstanceId() {
      calls.push("client-id");
      return "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    },
    ...overrides,
  };
  return { value, calls };
}

describe("CLI parser compatibility and V2 strictness", () => {
  it("preserves the complete legacy defaults and option behavior", () => {
    assert.deepEqual(parseCliArgs([]), defaultOptions("help"));
    assert.deepEqual(parseCliArgs(["report"]), {
      ...defaultOptions("report"),
      format: "markdown",
    });
    assert.deepEqual(parseCliArgs([
      "fix", "--apply", "--no-backup", "--unsafe", "--confirm", "--rollback",
      "--format", "json", "--vault", "vault", "--path", "a.md", "--path", "b.md",
    ]), {
      ...defaultOptions("fix"),
      dryRun: false,
      backup: false,
      unsafe: true,
      confirm: true,
      rollback: true,
      format: "json",
      vault: "vault",
      paths: ["a.md", "b.md"],
    });
    assert.equal(parseCliArgs(["unknown-command"]).command, "help");
    assert.equal(parseCliArgs(["validate", "--format"]).format, "text");
    assert.equal(parseCliArgs(["validate", "--vault"]).vault, undefined);
    assert.deepEqual(parseCliArgs(["validate", "--unknown", "ignored"]), defaultOptions("validate"));
  });

  it("keeps legacy help byte-identical and appends the V2 section", () => {
    assert.equal(Buffer.byteLength(LEGACY_HELP, "utf8"), 1440);
    assert.equal(
      createHash("sha256").update(LEGACY_HELP, "utf8").digest("hex"),
      "2c8cc3af6a2cea483b33dea3eb6b88ef580633004a32de8cdaea74d9d3a0af85",
    );
    assert.equal(HELP.startsWith(LEGACY_HELP), true);
    assert.equal(HELP.slice(LEGACY_HELP.length), `
V2 event-store administration:
  orchestrator-init       Inspect or explicitly initialize V2 identity/store (--apply writes)
  orchestrator-status     Verify and print one explicitly bound V2 project/store
  orchestrator-integrity  Run quick integrity, or full integrity with --full

V2 options:
  --project-root <path>   Required literal project root.
  --vault <path>          Required literal vault root.
  --replica initialize-local  Explicitly initialize a local replica.
  --full                  Run full event-store integrity.
`);
  });

  it("parses the V2 fields and rejects missing or unknown values with code 2", () => {
    assert.deepEqual(parseCliArgs([
      "orchestrator-init", "--project-root", "project", "--vault", "vault",
      "--replica", "initialize-local", "--apply", "--full",
    ]), {
      ...defaultOptions("orchestrator-init"),
      dryRun: false,
      projectRoot: "project",
      vault: "vault",
      replicaDecision: "initialize-local",
      fullIntegrity: true,
    });
    for (const argv of [
      ["orchestrator-status", "--project-root"],
      ["orchestrator-status", "--vault"],
      ["orchestrator-init", "--replica"],
      ["orchestrator-init", "--replica", "clone"],
    ]) {
      assert.throws(() => parseCliArgs(argv), (error) => {
        assert.ok(error instanceof CliUsageError);
        assert.equal((error as CliUsageError).exitCode, 2);
        return true;
      });
    }
  });

  it("keeps all new administration flags inert for legacy commands", () => {
    assert.deepEqual(
      parseCliArgs(["validate", "--project-root"]),
      defaultOptions("validate"),
    );
    assert.deepEqual(
      parseCliArgs(["validate", "--replica", "unknown", "--full"]),
      defaultOptions("validate"),
    );
    assert.deepEqual(
      parseCliArgs([
        "migrate",
        "--project-root",
        "ignored-project",
        "--replica",
        "initialize-local",
        "--full",
      ]),
      defaultOptions("migrate"),
    );
  });
});

describe("explicit V2 roots", () => {
  it("rejects absent, dynamic, auto, missing, sibling, and symlink-escape roots before dependencies", async () => {
    const variants: Array<Partial<CliOptions>> = [
      {},
      { projectRoot: "dynamic", vault: "C:\\vault" },
      { projectRoot: "C:\\project", vault: "auto" },
      { projectRoot: "C:\\missing", vault: "C:\\missing\\vault" },
    ];
    const real = temporaryProject();
    const sibling = resolve(real.projectRoot, "..", "sibling");
    mkdirSync(sibling);
    variants.push({ projectRoot: real.projectRoot, vault: sibling });
    const linkedVault = resolve(real.projectRoot, "linked-vault");
    symlinkSync(sibling, linkedVault, "junction");
    variants.push({ projectRoot: real.projectRoot, vault: linkedVault });

    for (const command of ["orchestrator-init", "orchestrator-status", "orchestrator-integrity"] as const) {
      for (const variant of variants) {
        const fake = dependencies();
        const capture = outputCapture();
        const exitCode = await runCliCommand({
          ...defaultOptions(command),
          ...variant,
        }, capture.io, fake.value);
        assert.equal(exitCode, 2);
        assert.deepEqual(fake.calls, []);
        assert.equal(capture.stdout(), "");
        assert.equal(capture.stderr().endsWith("\n"), true);
        const error = JSON.parse(capture.stderr()) as Record<string, unknown>;
        assert.equal(error.ok, false);
        assert.equal(typeof error.code, "string");
      }
    }
  });
});

describe("V2 administration lifecycle", () => {
  it("keeps init dry-run inspection-only and does not guess a route", async () => {
    const roots = temporaryProject();
    const fake = dependencies();
    const capture = outputCapture();
    const exitCode = await runCliCommand({
      ...defaultOptions("orchestrator-init"),
      projectRoot: roots.projectRoot,
      vault: roots.vaultRoot,
    }, capture.io, fake.value);
    assert.equal(exitCode, 0);
    assert.deepEqual(fake.calls, [
      "client-id",
      "runtime",
      `inspect:${roots.projectRoot}:${roots.vaultRoot}`,
    ]);
    const output = JSON.parse(capture.stdout()) as {
      action: string;
      inspection: { summary: Record<string, unknown> };
    };
    assert.equal(output.action, "init-inspection");
    assert.deepEqual(output.inspection.summary, {
      projectRoot: roots.projectRoot,
      vaultRoot: roots.vaultRoot,
      routeState: "pending-project-identity",
    });
    assert.equal(capture.stderr(), "");
  });

  it("leaves the project tree byte-for-byte unchanged during real initialization inspection", async () => {
    const roots = temporaryProject();
    writeFileSync(join(roots.vaultRoot, "existing.md"), "# existing\n", "utf8");
    const inspector = createProjectInitializationInspector({
      async verify() { throw new Error("database must not be probed for a new project"); },
      async inspectExisting() { throw new Error("database must not be probed for a new project"); },
    });
    const fake = dependencies({ inspectInitialization: inspector });
    const before = treeDigest(roots.projectRoot);
    const capture = outputCapture();
    const code = await runCliCommand({
      ...defaultOptions("orchestrator-init"),
      projectRoot: roots.projectRoot,
      vault: roots.vaultRoot,
    }, capture.io, fake.value);
    assert.equal(code, 0);
    assert.equal(treeDigest(roots.projectRoot), before);
    const output = JSON.parse(capture.stdout()) as {
      inspection: { summary: Record<string, unknown> };
    };
    assert.deepEqual(output.inspection.summary, {
      projectRoot: roots.projectRoot,
      vaultRoot: roots.vaultRoot,
      routeState: "pending-project-identity",
    });
  });

  for (const invalidInspection of [
    {
      name: "initialized state with a pending summary",
      create(roots: { projectRoot: string; vaultRoot: string }) {
        return {
          state: "initialized",
          summary: {
            projectRoot: roots.projectRoot,
            vaultRoot: roots.vaultRoot,
            routeState: "pending-project-identity",
          },
          remediation: [],
        } as unknown as ProjectInitializationInspection;
      },
    },
    {
      name: "initialized state without a store identity",
      create(roots: { projectRoot: string; vaultRoot: string }) {
        const storeRoot = resolve(roots.vaultRoot, ".memory-mcp", "v2");
        return {
          state: "initialized",
          summary: {
            projectRoot: roots.projectRoot,
            vaultRoot: roots.vaultRoot,
            routeState: "resolved",
            storeRoot,
            eventsPath: resolve(storeRoot, "events.sqlite"),
            projectId: "11111111-1111-4111-8111-111111111111",
            vaultId: "22222222-2222-4222-8222-222222222222",
          },
          remediation: [],
        } as unknown as ProjectInitializationInspection;
      },
    },
    {
      name: "events path outside the store root",
      create(roots: { projectRoot: string; vaultRoot: string }) {
        const storeRoot = resolve(roots.vaultRoot, ".memory-mcp", "v2");
        return {
          state: "initialized",
          summary: {
            projectRoot: roots.projectRoot,
            vaultRoot: roots.vaultRoot,
            routeState: "resolved",
            storeRoot,
            eventsPath: resolve(roots.projectRoot, "outside.sqlite"),
            projectId: "11111111-1111-4111-8111-111111111111",
            vaultId: "22222222-2222-4222-8222-222222222222",
            storeId: "33333333-3333-4333-8333-333333333333",
          },
          remediation: [],
        } as unknown as ProjectInitializationInspection;
      },
    },
    {
      name: "noncanonical database name inside the store root",
      create(roots: { projectRoot: string; vaultRoot: string }) {
        const storeRoot = resolve(roots.vaultRoot, ".memory-mcp", "v2");
        return {
          state: "initialized",
          summary: {
            projectRoot: roots.projectRoot,
            vaultRoot: roots.vaultRoot,
            routeState: "resolved",
            storeRoot,
            eventsPath: resolve(storeRoot, "RUNTIME_PATH_SECRET.sqlite"),
            projectId: "11111111-1111-4111-8111-111111111111",
            vaultId: "22222222-2222-4222-8222-222222222222",
            storeId: "33333333-3333-4333-8333-333333333333",
          },
          remediation: [],
        } as unknown as ProjectInitializationInspection;
      },
    },
    {
      name: "new-project state with a resolved summary",
      create(roots: { projectRoot: string; vaultRoot: string }) {
        const storeRoot = resolve(roots.vaultRoot, ".memory-mcp", "v2");
        return {
          state: "new-project",
          summary: {
            projectRoot: roots.projectRoot,
            vaultRoot: roots.vaultRoot,
            routeState: "resolved",
            storeRoot,
            eventsPath: resolve(storeRoot, "events.sqlite"),
            projectId: "11111111-1111-4111-8111-111111111111",
            vaultId: "22222222-2222-4222-8222-222222222222",
          },
          remediation: ["rerun with --apply"],
        } as unknown as ProjectInitializationInspection;
      },
    },
    {
      name: "summary roots outside the explicit request",
      create(roots: { projectRoot: string; vaultRoot: string }) {
        return {
          state: "new-project",
          summary: {
            projectRoot: resolve(roots.projectRoot, "..", "other-project"),
            vaultRoot: roots.vaultRoot,
            routeState: "pending-project-identity",
          },
          remediation: ["rerun with --apply"],
        } as unknown as ProjectInitializationInspection;
      },
    },
  ]) {
    it(`rejects an inconsistent initialization inspection: ${invalidInspection.name}`, async () => {
      const roots = temporaryProject();
      const fake = dependencies({
        async inspectInitialization() { return invalidInspection.create(roots); },
      });
      const capture = outputCapture();

      assert.equal(await runCliCommand({
        ...defaultOptions("orchestrator-init"),
        projectRoot: roots.projectRoot,
        vault: roots.vaultRoot,
      }, capture.io, fake.value), 1);
      assert.equal(capture.stdout(), "");
      assert.deepEqual(JSON.parse(capture.stderr()), {
        ok: false,
        code: "ORCHESTRATOR_ADMIN_FAILED",
        message: "Orchestrator administration failed",
      });
    });
  }

  it("probes initialized and recoverable stores only through disposable stable snapshots", async () => {
    const roots = temporaryProject();
    const initialized = await new DefaultProjectStoreBootstrapService().initialize(roots);
    const authoritativePath = initialized.route.eventsPath;
    const observedProbePaths: string[] = [];
    const assertDisposableSnapshot = (eventsPath: string): void => {
      observedProbePaths.push(eventsPath);
      assert.notEqual(eventsPath, authoritativePath);
      assert.equal(existsSync(eventsPath), true);
      assert.equal(readFileSync(eventsPath).length > 0, true);
    };
    const inspector = createProjectInitializationInspector({
      async verify(route) {
        assertDisposableSnapshot(route.eventsPath);
      },
      async inspectExisting(route, expected) {
        assertDisposableSnapshot(route.eventsPath);
        return { ...expected, storeId: initialized.manifest.storeId };
      },
    });

    const beforeInitialized = treeDigest(roots.projectRoot);
    const initializedInspection = await inspector(roots.projectRoot, roots.vaultRoot);
    assert.equal(initializedInspection.state, "initialized");
    assert.equal(treeDigest(roots.projectRoot), beforeInitialized);

    rmSync(initialized.route.storeManifestPath);
    const beforeRecovery = treeDigest(roots.projectRoot);
    const recoveryInspection = await inspector(roots.projectRoot, roots.vaultRoot);
    assert.equal(recoveryInspection.state, "recoverable-manifest");
    if (recoveryInspection.state === "recoverable-manifest") {
      assert.equal(recoveryInspection.summary.storeId, initialized.manifest.storeId);
    }
    assert.equal(treeDigest(roots.projectRoot), beforeRecovery);
    assert.equal(observedProbePaths.length, 2);
    assert.equal(observedProbePaths.every((path) => !existsSync(path)), true);
  });

  it("fails concrete inspection closed when the authoritative WAL path is non-regular", async () => {
    const roots = temporaryProject();
    const initialized = await new DefaultProjectStoreBootstrapService().initialize(roots);
    const workerUrl = new URL("../src/workers/project-store.worker.js", import.meta.url);
    const inspector = createOrchestratorAdminDependencies(workerUrl).inspectInitialization;
    const walPath = `${initialized.route.eventsPath}-wal`;
    const shmPath = `${initialized.route.eventsPath}-shm`;

    const database = new DatabaseSync(initialized.route.eventsPath);
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    database.close();
    rmSync(walPath, { force: true });
    rmSync(shmPath, { force: true });

    assert.equal(existsSync(walPath), false);
    const beforeNormalInspection = treeDigest(roots.projectRoot);
    const normalInspection = await inspector(roots.projectRoot, roots.vaultRoot);
    assert.equal(normalInspection.state, "initialized");
    assert.equal(treeDigest(roots.projectRoot), beforeNormalInspection);

    mkdirSync(walPath);
    const beforeInvalidInspection = treeDigest(roots.projectRoot);
    const invalidInspection = await inspector(roots.projectRoot, roots.vaultRoot);
    assert.equal(invalidInspection.state, "blocked");
    if (invalidInspection.state === "blocked") {
      assert.equal(invalidInspection.code, "STORE_UNAVAILABLE");
    }
    assert.equal(treeDigest(roots.projectRoot), beforeInvalidInspection);
    assert.equal(statSync(walPath).isDirectory(), true);
  });

  it("fails concrete inspection closed when the authoritative SHM path is non-regular", async () => {
    const roots = temporaryProject();
    const initialized = await new DefaultProjectStoreBootstrapService().initialize(roots);
    const workerUrl = new URL("../src/workers/project-store.worker.js", import.meta.url);
    const inspector = createOrchestratorAdminDependencies(workerUrl).inspectInitialization;
    const walPath = `${initialized.route.eventsPath}-wal`;
    const shmPath = `${initialized.route.eventsPath}-shm`;

    const database = new DatabaseSync(initialized.route.eventsPath);
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    database.close();
    rmSync(walPath, { force: true });
    rmSync(shmPath, { force: true });
    mkdirSync(shmPath);

    const beforeInspection = treeDigest(roots.projectRoot);
    const inspection = await inspector(roots.projectRoot, roots.vaultRoot);
    assert.equal(inspection.state, "blocked");
    if (inspection.state === "blocked") {
      assert.equal(inspection.code, "STORE_UNAVAILABLE");
    }
    assert.equal(treeDigest(roots.projectRoot), beforeInspection);
    assert.equal(statSync(shmPath).isDirectory(), true);
  });

  it("does not launder a junctioned authoritative store through a temporary snapshot", {
    skip: process.platform !== "win32",
  }, async () => {
    const roots = temporaryProject();
    const initialized = await new DefaultProjectStoreBootstrapService().initialize(roots);
    const workerUrl = new URL("../src/workers/project-store.worker.js", import.meta.url);
    const relocatedStoreRoot = resolve(initialized.route.storeRoot, "..", "v2-relocated");
    renameSync(initialized.route.storeRoot, relocatedStoreRoot);
    symlinkSync(relocatedStoreRoot, initialized.route.storeRoot, "junction");

    const directProbe = new WorkerProjectStoreIdentityProbe({ workerUrl });
    await assert.rejects(directProbe.verify(initialized.route, {
      projectId: initialized.descriptor.projectId,
      vaultId: initialized.descriptor.vaultId,
      storeId: initialized.manifest.storeId,
    }), (error) => {
      assert.ok(error instanceof ProjectBindingError);
      assert.equal(error.code, "STORE_UNAVAILABLE");
      return true;
    });

    const inspector = createOrchestratorAdminDependencies(workerUrl).inspectInitialization;
    const beforeInspection = treeDigest(roots.projectRoot);
    const inspection = await inspector(roots.projectRoot, roots.vaultRoot);
    assert.equal(inspection.state, "blocked");
    if (inspection.state === "blocked") {
      assert.equal(inspection.code, "STORE_UNAVAILABLE");
    }
    assert.equal(treeDigest(roots.projectRoot), beforeInspection);
  });

  it("applies new initialization, recovers a missing manifest, and remains idempotent", async () => {
    const roots = temporaryProject();
    const bootstrap = new DefaultProjectStoreBootstrapService();
    const workerUrl = new URL("../src/workers/project-store.worker.js", import.meta.url);
    const real = createOrchestratorAdminDependencies(workerUrl);
    const fake = dependencies({
      bootstrap,
      bindingService: real.bindingService,
      inspectWorkspaceAuthority: real.inspectWorkspaceAuthority,
    });

    const apply = async (): Promise<{
      code: 0 | 1 | 2;
      output: { result: Record<string, unknown> };
    }> => {
      const capture = outputCapture();
      const code = await runCliCommand({
        ...defaultOptions("orchestrator-init"),
        dryRun: false,
        projectRoot: roots.projectRoot,
        vault: roots.vaultRoot,
      }, capture.io, fake.value);
      return {
        code,
        output: JSON.parse(capture.stdout()) as { result: Record<string, unknown> },
      };
    };

    const created = await apply();
    assert.equal(created.code, 0);
    assert.equal(created.output.result.createdDescriptor, true);
    assert.equal(created.output.result.createdStore, true);
    assert.equal(created.output.result.recoveredManifest, false);

    const repeated = await apply();
    assert.equal(repeated.code, 0);
    assert.equal(repeated.output.result.createdDescriptor, false);
    assert.equal(repeated.output.result.createdStore, false);
    assert.equal(repeated.output.result.recoveredManifest, false);

    const route = created.output.result.route as { storeManifestPath: string };
    rmSync(route.storeManifestPath);
    const recovered = await apply();
    assert.equal(recovered.code, 0);
    assert.equal(recovered.output.result.createdDescriptor, false);
    assert.equal(recovered.output.result.createdStore, false);
    assert.equal(recovered.output.result.recoveredManifest, true);

    const afterRecovery = await apply();
    assert.equal(afterRecovery.code, 0);
    assert.equal(afterRecovery.output.result.recoveredManifest, false);
  });

  it("requires and forwards the explicit replica decision for descriptor-only clones", async () => {
    const roots = temporaryProject();
    new ProjectDescriptorRepository().createExplicit(roots.projectRoot, roots.vaultRoot);
    const workerUrl = new URL("../src/workers/project-store.worker.js", import.meta.url);
    const real = createOrchestratorAdminDependencies(workerUrl);
    const fake = dependencies({
      bootstrap: new DefaultProjectStoreBootstrapService(),
      bindingService: real.bindingService,
      inspectWorkspaceAuthority: real.inspectWorkspaceAuthority,
      inspectInitialization: createProjectInitializationInspector({
        async verify() { throw new Error("database is absent"); },
        async inspectExisting() { throw new Error("database is absent"); },
      }),
    });

    const inspection = outputCapture();
    assert.equal(await runCliCommand({
      ...defaultOptions("orchestrator-init"),
      projectRoot: roots.projectRoot,
      vault: roots.vaultRoot,
    }, inspection.io, fake.value), 0);
    assert.equal(
      (JSON.parse(inspection.stdout()) as { inspection: { state: string } }).inspection.state,
      "replica-decision-required",
    );

    const missingDecision = outputCapture();
    const rejected = await runCliCommand({
      ...defaultOptions("orchestrator-init"),
      dryRun: false,
      projectRoot: roots.projectRoot,
      vault: roots.vaultRoot,
    }, missingDecision.io, fake.value);
    assert.equal(rejected, 1);
    assert.equal(missingDecision.stdout(), "");
    assert.equal(
      (JSON.parse(missingDecision.stderr()) as { code: string }).code,
      "PROJECT_REPLICA_DECISION_REQUIRED",
    );

    const approved = outputCapture();
    const initialized = await runCliCommand({
      ...defaultOptions("orchestrator-init"),
      dryRun: false,
      projectRoot: roots.projectRoot,
      vault: roots.vaultRoot,
      replicaDecision: "initialize-local",
    }, approved.io, fake.value);
    assert.equal(initialized, 0);
    assert.equal(
      (JSON.parse(approved.stdout()) as { result: { createdStore: boolean } }).result.createdStore,
      true,
    );
  });

  it("fails closed when an existing manifest identity does not match its database", async () => {
    const roots = temporaryProject();
    const bootstrap = new DefaultProjectStoreBootstrapService();
    const initialized = await bootstrap.initialize(roots);
    const manifest = JSON.parse(readFileSync(initialized.route.storeManifestPath, "utf8")) as {
      storeId: string;
    };
    manifest.storeId = "99999999-9999-4999-8999-999999999999";
    writeFileSync(
      initialized.route.storeManifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
    const fake = dependencies({ bootstrap });
    const capture = outputCapture();
    const code = await runCliCommand({
      ...defaultOptions("orchestrator-init"),
      dryRun: false,
      projectRoot: roots.projectRoot,
      vault: roots.vaultRoot,
    }, capture.io, fake.value);
    assert.equal(code, 1);
    assert.equal(capture.stdout(), "");
    assert.equal((JSON.parse(capture.stderr()) as { code: string }).code, "STORE_UNAVAILABLE");
  });

  for (const hostileBootstrap of [
    {
      name: "descriptor timestamp",
      mutate(result: ProjectStoreBootstrapResult): ProjectStoreBootstrapResult {
        return {
          ...result,
          descriptor: {
            ...result.descriptor,
            createdAt: {
              toJSON() { return "BOOTSTRAP_CREATED_AT_SECRET"; },
            } as unknown as string,
          },
        };
      },
    },
    {
      name: "events route",
      mutate(result: ProjectStoreBootstrapResult): ProjectStoreBootstrapResult {
        return {
          ...result,
          route: {
            ...result.route,
            eventsPath: {
              toJSON() { return "BOOTSTRAP_ROUTE_SECRET"; },
            } as unknown as string,
          },
        };
      },
    },
  ]) {
    it(`rejects dependency-owned bootstrap output: ${hostileBootstrap.name}`, async () => {
      const roots = temporaryProject();
      const initialized = await new DefaultProjectStoreBootstrapService().initialize(roots);
      const fake = dependencies({
        bootstrap: {
          async initialize() { return hostileBootstrap.mutate(initialized); },
        },
      });
      const capture = outputCapture();

      assert.equal(await runCliCommand({
        ...defaultOptions("orchestrator-init"),
        dryRun: false,
        projectRoot: roots.projectRoot,
        vault: roots.vaultRoot,
      }, capture.io, fake.value), 1);
      assert.equal(capture.stdout(), "");
      assert.deepEqual(JSON.parse(capture.stderr()), {
        ok: false,
        code: "ORCHESTRATOR_ADMIN_FAILED",
        message: "Orchestrator administration failed",
      });
      assert.equal(capture.stderr().includes("BOOTSTRAP_"), false);
    });
  }

  it("rejects a valid-looking bootstrap result outside the explicit project authority", async () => {
    const roots = temporaryProject();
    const initialized = await new DefaultProjectStoreBootstrapService().initialize(roots);
    const foreignStoreRoot = resolve(
      roots.projectRoot,
      "BOOTSTRAP_FOREIGN_SECRET",
      ".memory-mcp",
      "v2",
    );
    const foreignResult = {
      ...initialized,
      descriptor: {
        ...initialized.descriptor,
        projectId: "99999999-9999-4999-8999-999999999999",
        vaultId: "88888888-8888-4888-8888-888888888888",
      },
      manifest: {
        ...initialized.manifest,
        projectId: "99999999-9999-4999-8999-999999999999",
        vaultId: "88888888-8888-4888-8888-888888888888",
        storeId: "77777777-7777-4777-8777-777777777777",
      },
      route: {
        kind: "vault-local",
        storeRoot: foreignStoreRoot,
        eventsPath: join(foreignStoreRoot, "events.sqlite"),
        storeManifestPath: join(foreignStoreRoot, "store-manifest.json"),
        projectionManifestPath: join(foreignStoreRoot, "current-projection.json"),
      },
    } as ProjectStoreBootstrapResult;
    const workerUrl = new URL("../src/workers/project-store.worker.js", import.meta.url);
    const real = createOrchestratorAdminDependencies(workerUrl);
    const guarded: OrchestratorAdminDependencies = {
      ...real,
      bootstrap: {
        async initialize() { return foreignResult; },
      },
    };
    const capture = outputCapture();

    assert.equal(await runCliCommand({
      ...defaultOptions("orchestrator-init"),
      dryRun: false,
      projectRoot: roots.projectRoot,
      vault: roots.vaultRoot,
    }, capture.io, guarded), 1);
    assert.equal(capture.stdout(), "");
    assert.deepEqual(JSON.parse(capture.stderr()), {
      ok: false,
      code: "ORCHESTRATOR_ADMIN_FAILED",
      message: "Orchestrator administration failed",
    });
    assert.equal(capture.stderr().includes("BOOTSTRAP_FOREIGN_SECRET"), false);
  });

  it("stops after a failed disposable runtime probe and never reaches a store dependency", async () => {
    const roots = temporaryProject();
    const fake = dependencies({
      async runtimeProbe() {
        fake.calls.push("runtime");
        return {
          ok: false,
          code: "SQLITE_CAPABILITY_MISSING",
          message: "secret runtime diagnostic",
          nodeVersion: "0.0.0",
          checks: { secret: false },
        };
      },
    });
    const capture = outputCapture();
    const code = await runCliCommand({
      ...defaultOptions("orchestrator-status"),
      projectRoot: roots.projectRoot,
      vault: roots.vaultRoot,
    }, capture.io, fake.value);
    assert.equal(code, 1);
    assert.deepEqual(fake.calls, ["client-id", "runtime"]);
    assert.equal(capture.stdout(), "");
    assert.equal(capture.stderr().includes("secret runtime diagnostic"), false);
    assert.equal(
      (JSON.parse(capture.stderr()) as { code: string }).code,
      "SQLITE_CAPABILITY_MISSING",
    );
  });

  it("rejects a hostile successful runtime report before serializing dependency data", async () => {
    const roots = temporaryProject();
    const fake = dependencies({
      async runtimeProbe() {
        return {
          ok: true,
          ...RUNTIME,
          nodeVersion: {
            toJSON() { return "RUNTIME_REPORT_SECRET"; },
          },
        } as unknown as { ok: true } & RuntimeCapabilityReport;
      },
    });
    const capture = outputCapture();

    assert.equal(await runCliCommand({
      ...defaultOptions("orchestrator-status"),
      projectRoot: roots.projectRoot,
      vault: roots.vaultRoot,
    }, capture.io, fake.value), 1);
    assert.equal(capture.stdout(), "");
    assert.deepEqual(JSON.parse(capture.stderr()), {
      ok: false,
      code: "ORCHESTRATOR_ADMIN_FAILED",
      message: "Orchestrator administration failed",
    });
    assert.equal(capture.stderr().includes("RUNTIME_REPORT_SECRET"), false);
  });

  it("rejects an unbounded runtime version string before status output", async () => {
    const roots = temporaryProject();
    const fake = dependencies({
      async runtimeProbe() {
        return {
          ok: true,
          ...RUNTIME,
          nodeVersion: "RUNTIME_VERSION_SECRET",
        };
      },
    });
    const capture = outputCapture();

    assert.equal(await runCliCommand({
      ...defaultOptions("orchestrator-status"),
      projectRoot: roots.projectRoot,
      vault: roots.vaultRoot,
    }, capture.io, fake.value), 1);
    assert.equal(capture.stdout(), "");
    assert.deepEqual(JSON.parse(capture.stderr()), {
      ok: false,
      code: "ORCHESTRATOR_ADMIN_FAILED",
      message: "Orchestrator administration failed",
    });
    assert.equal(capture.stderr().includes("RUNTIME_VERSION_SECRET"), false);
  });

  for (const belowMinimum of [
    { name: "Node.js", runtime: { ...RUNTIME, nodeVersion: "0.0.0" } },
    { name: "SQLite", runtime: { ...RUNTIME, sqliteVersion: "0.0.0" } },
  ]) {
    it(`rejects a successful runtime report below the minimum ${belowMinimum.name} version`, async () => {
      const roots = temporaryProject();
      const binding = statusBindingFor(roots);
      const fake = dependencies({
        async runtimeProbe() { return { ok: true, ...belowMinimum.runtime }; },
        bindingService: {
          async establish() { return { ok: true, binding }; },
          async revalidate() { return CONTEXT; },
        },
      });
      const capture = outputCapture();

      assert.equal(await runCliCommand({
        ...defaultOptions("orchestrator-status"),
        projectRoot: roots.projectRoot,
        vault: roots.vaultRoot,
      }, capture.io, fake.value), 1);
      assert.equal(capture.stdout(), "");
      assert.deepEqual(JSON.parse(capture.stderr()), {
        ok: false,
        code: "ORCHESTRATOR_ADMIN_FAILED",
        message: "Orchestrator administration failed",
      });
    });
  }

  it("accepts a real nested project root inside its observed Git worktree", async () => {
    const repository = temporaryGitRepository();
    const roots = {
      projectRoot: resolve(repository.repositoryRoot, "packages", "app"),
      vaultRoot: resolve(repository.repositoryRoot, "packages", "app", "memory"),
    };
    mkdirSync(roots.vaultRoot, { recursive: true });
    const initialized = await new DefaultProjectStoreBootstrapService().initialize(roots);
    const workerUrl = new URL("../src/workers/project-store.worker.js", import.meta.url);
    const real = createOrchestratorAdminDependencies(workerUrl);
    const guarded: OrchestratorAdminDependencies = {
      ...real,
      async runtimeProbe() { return { ok: true, ...RUNTIME }; },
    };
    const capture = outputCapture();

    assert.equal(await runCliCommand({
      ...defaultOptions("orchestrator-status"),
      projectRoot: roots.projectRoot,
      vault: roots.vaultRoot,
    }, capture.io, guarded), 0);
    assert.equal(capture.stderr(), "");
    const status = JSON.parse(capture.stdout()) as {
      action: string;
      projectId: string;
      eventsPath: string;
    };
    assert.equal(status.action, "status");
    assert.equal(status.projectId, initialized.descriptor.projectId);
    assert.equal(status.eventsPath, initialized.route.eventsPath);
  });

  it("rejects a self-consistent Git binding routed through an unobserved external repository", async () => {
    const roots = temporaryProject();
    const initialized = await new DefaultProjectStoreBootstrapService().initialize(roots);
    const foreign = temporaryGitRepository();
    const workspaceId = deriveGitWorkspaceId(
      initialized.descriptor.projectId,
      foreign.gitCommonDir,
      foreign.gitDir,
    );
    const storeRoot = resolve(
      foreign.gitCommonDir,
      "project-memory",
      initialized.descriptor.projectId,
      "v2",
    );
    const forged = bindingWithFingerprint({
      projectBindingId: "55555555-5555-4555-8555-555555555555",
      generation: 1,
      source: "explicit-cli",
      projectId: initialized.descriptor.projectId,
      vaultId: initialized.descriptor.vaultId,
      storeId: initialized.manifest.storeId,
      workspaceId,
      clientNamespace: "memory-vault-cli",
      clientInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      actorRole: "untrusted",
      projectRoot: roots.projectRoot,
      vaultRoot: roots.vaultRoot,
      descriptorPath: join(roots.vaultRoot, ".memory-mcp", "project-identity.json"),
      storeRoute: {
        kind: "git-common",
        storeRoot,
        eventsPath: join(storeRoot, "events.sqlite"),
        storeManifestPath: join(storeRoot, "store-manifest.json"),
        projectionManifestPath: join(storeRoot, "current-projection.json"),
      },
      workspace: {
        kind: "git",
        worktreeRoot: roots.projectRoot,
        gitDir: foreign.gitDir,
        gitCommonDir: foreign.gitCommonDir,
        headCommit: foreign.headCommit,
        branchRef: foreign.branchRef,
        detached: false,
        workspaceId,
      },
      establishedAt: "2026-07-13T00:00:00.000Z",
    });
    const workerUrl = new URL("../src/workers/project-store.worker.js", import.meta.url);
    const real = createOrchestratorAdminDependencies(workerUrl);
    const guarded: OrchestratorAdminDependencies = {
      ...real,
      async runtimeProbe() { return { ok: true, ...RUNTIME }; },
      clientInstanceId() { return "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; },
      bindingService: {
        async establish() { return { ok: true, binding: forged }; },
        async revalidate() { return contextForBinding(forged); },
      },
    };
    const capture = outputCapture();

    assert.equal(await runCliCommand({
      ...defaultOptions("orchestrator-status"),
      projectRoot: roots.projectRoot,
      vault: roots.vaultRoot,
    }, capture.io, guarded), 1);
    assert.equal(capture.stdout(), "");
    assert.deepEqual(JSON.parse(capture.stderr()), {
      ok: false,
      code: "ORCHESTRATOR_ADMIN_FAILED",
      message: "Orchestrator administration failed",
    });
    assert.equal(capture.stderr().includes(foreign.gitCommonDir), false);
  });

  it("rejects a forged non-Git authority when the requested roots have no observed project", async () => {
    const roots = temporaryProject();
    const projectId = "99999999-9999-4999-8999-999999999999" as ProjectBinding["projectId"];
    const vaultId = "88888888-8888-4888-8888-888888888888" as ProjectBinding["vaultId"];
    const storeId = "77777777-7777-4777-8777-777777777777" as ProjectBinding["storeId"];
    const workspaceId = deriveNonGitWorkspaceId(projectId, vaultId);
    const storeRoot = resolve(roots.vaultRoot, ".memory-mcp", "v2");
    const forged = bindingWithFingerprint({
      projectBindingId: "66666666-6666-4666-8666-666666666666",
      generation: 1,
      source: "explicit-cli",
      projectId,
      vaultId,
      storeId,
      workspaceId,
      clientNamespace: "memory-vault-cli",
      clientInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      actorRole: "maintenance",
      projectRoot: roots.projectRoot,
      vaultRoot: roots.vaultRoot,
      descriptorPath: join(roots.vaultRoot, ".memory-mcp", "project-identity.json"),
      storeRoute: {
        kind: "vault-local",
        storeRoot,
        eventsPath: join(storeRoot, "events.sqlite"),
        storeManifestPath: join(storeRoot, "store-manifest.json"),
        projectionManifestPath: join(storeRoot, "current-projection.json"),
      },
      workspace: {
        kind: "non-git",
        workspaceRoot: roots.projectRoot,
        workspaceId,
      },
      establishedAt: "2026-07-13T00:00:00.000Z",
    });
    const report = { ...QUICK_REPORT, projectId, storeId };
    let executorCalls = 0;
    let recorderCalls = 0;
    const workerUrl = new URL("../src/workers/project-store.worker.js", import.meta.url);
    const real = createOrchestratorAdminDependencies(workerUrl);
    const guarded: OrchestratorAdminDependencies = {
      ...real,
      async runtimeProbe() { return { ok: true, ...RUNTIME }; },
      clientInstanceId() { return "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; },
      bindingService: {
        async establish() { return { ok: true, binding: forged }; },
        async revalidate() { return contextForBinding(forged); },
      },
      executorFactory() {
        executorCalls += 1;
        return {
          async open() { return {}; },
          async quickIntegrity() { return report; },
          async fullIntegrity() { return { ...report, mode: "full" }; },
          async close() {},
        };
      },
      integrityRecorder: {
        async record() { recorderCalls += 1; },
      },
    };
    const capture = outputCapture();

    assert.equal(await runCliCommand({
      ...defaultOptions("orchestrator-integrity"),
      projectRoot: roots.projectRoot,
      vault: roots.vaultRoot,
    }, capture.io, guarded), 1);
    assert.equal(executorCalls, 0);
    assert.equal(recorderCalls, 0);
    assert.equal(capture.stdout(), "");
    assert.deepEqual(JSON.parse(capture.stderr()), {
      ok: false,
      code: "ORCHESTRATOR_ADMIN_FAILED",
      message: "Orchestrator administration failed",
    });
  });

  it("establishes status as untrusted and emits only the safe projection", async () => {
    const roots = temporaryProject();
    const binding = statusBindingFor(roots);
    const fake = dependencies({
      bindingService: {
        async establish() {
          fake.calls.push("establish:untrusted");
          return { ok: true, binding };
        },
        async revalidate() { return CONTEXT; },
      },
    });
    const capture = outputCapture();
    const code = await runCliCommand({
      ...defaultOptions("orchestrator-status"),
      projectRoot: roots.projectRoot,
      vault: roots.vaultRoot,
    }, capture.io, fake.value);
    assert.equal(code, 0);
    assert.deepEqual(fake.calls, [
      "client-id", "runtime", "establish:untrusted", "authority",
    ]);
    const output = capture.stdout();
    assert.equal(output.includes(binding.projectBindingId), false);
    assert.equal(output.includes(binding.contextFingerprint), false);
    assert.equal(output.includes("private-client-id"), false);
    assert.deepEqual(JSON.parse(output), {
      action: "status",
      projectId: binding.projectId,
      vaultId: binding.vaultId,
      storeId: binding.storeId,
      workspaceId: binding.workspaceId,
      eventsPath: binding.storeRoute.eventsPath,
      runtime: RUNTIME,
    });
  });

  for (const hostileStatus of [
    {
      name: "workspace identity",
      mutate(binding: ProjectBinding): ProjectBinding {
        return {
          ...binding,
          workspaceId: {
            toJSON() { return "STATUS_WORKSPACE_SECRET"; },
          } as unknown as ProjectBinding["workspaceId"],
        };
      },
    },
    {
      name: "events route",
      mutate(binding: ProjectBinding): ProjectBinding {
        return {
          ...binding,
          storeRoute: {
            ...binding.storeRoute,
            eventsPath: {
              toJSON() { return "STATUS_ROUTE_SECRET"; },
            } as unknown as string,
          },
        };
      },
    },
    {
      name: "non-canonical events filename",
      mutate(binding: ProjectBinding): ProjectBinding {
        return {
          ...binding,
          storeRoute: {
            ...binding.storeRoute,
            eventsPath: join(binding.storeRoute.storeRoot, "renamed.sqlite"),
          },
        };
      },
    },
    {
      name: "inconsistent workspace identity",
      mutate(binding: ProjectBinding): ProjectBinding {
        return {
          ...binding,
          workspace: {
            ...binding.workspace,
            workspaceId: "workspace-other-id" as ProjectBinding["workspaceId"],
          },
        };
      },
    },
    {
      name: "self-consistent but non-derived non-Git workspace identity",
      mutate(binding: ProjectBinding): ProjectBinding {
        const workspaceId = "f".repeat(64) as ProjectBinding["workspaceId"];
        return refingerprintBinding({
          ...binding,
          workspaceId,
          workspace: {
            kind: "non-git",
            workspaceRoot: binding.projectRoot,
            workspaceId,
          },
        });
      },
    },
    {
      name: "incoherent Git branch metadata",
      mutate(binding: ProjectBinding): ProjectBinding {
        const gitBinding = gitStatusBindingFor(binding);
        if (gitBinding.workspace.kind !== "git") throw new Error("git fixture invalid");
        return refingerprintBinding({
          ...gitBinding,
          workspace: {
            ...gitBinding.workspace,
            branchRef: null,
            detached: false,
          },
        });
      },
    },
    {
      name: "hostile Git head commit",
      mutate(binding: ProjectBinding): ProjectBinding {
        const gitBinding = gitStatusBindingFor(binding);
        if (gitBinding.workspace.kind !== "git") throw new Error("git fixture invalid");
        return {
          ...gitBinding,
          workspace: {
            ...gitBinding.workspace,
            headCommit: {
              toJSON() { return "STATUS_GIT_HEAD_SECRET"; },
            } as unknown as string,
          },
        };
      },
    },
    {
      name: "Git worktree outside the explicit project root",
      mutate(binding: ProjectBinding): ProjectBinding {
        const gitBinding = gitStatusBindingFor(binding);
        if (gitBinding.workspace.kind !== "git") throw new Error("git fixture invalid");
        return refingerprintBinding({
          ...gitBinding,
          workspace: {
            ...gitBinding.workspace,
            worktreeRoot: resolve(binding.projectRoot, "..", "sibling-worktree"),
          },
        });
      },
    },
    {
      name: "foreign explicit roots",
      mutate(binding: ProjectBinding): ProjectBinding {
        return {
          ...binding,
          projectRoot: resolve(binding.projectRoot, "foreign-project"),
        };
      },
    },
    {
      name: "foreign request identity",
      mutate(binding: ProjectBinding): ProjectBinding {
        return { ...binding, actorRole: "maintenance" };
      },
    },
    {
      name: "non-UUID private binding identity",
      mutate(binding: ProjectBinding): ProjectBinding {
        return { ...binding, projectBindingId: "STATUS_BINDING_ID_SECRET" };
      },
    },
    {
      name: "impossible established timestamp",
      mutate(binding: ProjectBinding): ProjectBinding {
        return { ...binding, establishedAt: "2026-02-30T00:00:00Z" };
      },
    },
  ]) {
    it(`rejects dependency-owned status output: ${hostileStatus.name}`, async () => {
      const roots = temporaryProject();
      const binding = hostileStatus.mutate(statusBindingFor(roots));
      const fake = dependencies({
        bindingService: {
          async establish() { return { ok: true, binding }; },
          async revalidate() { return CONTEXT; },
        },
      });
      const capture = outputCapture();

      assert.equal(await runCliCommand({
        ...defaultOptions("orchestrator-status"),
        projectRoot: roots.projectRoot,
        vault: roots.vaultRoot,
      }, capture.io, fake.value), 1);
      assert.equal(capture.stdout(), "");
      assert.deepEqual(JSON.parse(capture.stderr()), {
        ok: false,
        code: "ORCHESTRATOR_ADMIN_FAILED",
        message: "Orchestrator administration failed",
      });
      assert.equal(capture.stderr().includes("STATUS_"), false);
    });
  }

  it("passes the canonical explicit binding request with no inferred roots", async () => {
    const roots = temporaryProject();
    const binding = statusBindingFor(roots);
    let observed: TrustedProjectBindingRequest | undefined;
    const fake = dependencies({
      bindingService: {
        async establish(request) {
          observed = request;
          return { ok: true, binding };
        },
        async revalidate() { return CONTEXT; },
      },
    });
    const capture = outputCapture();
    assert.equal(await runCliCommand({
      ...defaultOptions("orchestrator-status"),
      projectRoot: join(roots.projectRoot, "."),
      vault: join(roots.vaultRoot, "."),
    }, capture.io, fake.value), 0);
    assert.deepEqual(observed, {
      source: "explicit-cli",
      projectRoot: roots.projectRoot,
      vaultRoot: roots.vaultRoot,
      clientNamespace: "memory-vault-cli",
      clientInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      actorRole: "untrusted",
      generation: 1,
    });
  });

  it("revalidates integrity context, opens, verifies, closes, and never appends", async () => {
    const roots = temporaryProject();
    const fake = dependencies();
    const capture = outputCapture();
    const code = await runCliCommand({
      ...defaultOptions("orchestrator-integrity"),
      projectRoot: roots.projectRoot,
      vault: roots.vaultRoot,
      fullIntegrity: true,
    }, capture.io, fake.value);
    assert.equal(code, 0);
    assert.deepEqual(fake.calls, [
      "client-id", "runtime", "establish:maintenance", "authority", "revalidate",
      "executor", "open", "full", "close", "record",
    ]);
    assert.deepEqual(JSON.parse(capture.stdout()), {
      action: "integrity",
      report: { ...QUICK_REPORT, mode: "full" },
    });
  });

  it("rejects a revalidated integrity context that swaps established request authority", async () => {
    const roots = temporaryProject();
    const established = maintenanceBindingFor(roots);
    const foreignProjectId = "99999999-9999-4999-8999-999999999999" as ProjectBinding["projectId"];
    const foreignVaultId = "88888888-8888-4888-8888-888888888888" as ProjectBinding["vaultId"];
    const gitCommonDir = resolve(roots.projectRoot, ".git");
    const gitDir = resolve(gitCommonDir, "worktrees", "foreign");
    const workspaceId = deriveGitWorkspaceId(foreignProjectId, gitCommonDir, gitDir);
    const storeRoot = resolve(gitCommonDir, "project-memory", foreignProjectId, "v2");
    const workspace = {
      kind: "git" as const,
      worktreeRoot: roots.projectRoot,
      gitDir,
      gitCommonDir,
      headCommit: "b".repeat(40),
      branchRef: "refs/heads/foreign",
      detached: false,
      workspaceId,
    };
    const foreignBindingId = "55555555-5555-4555-8555-555555555555";
    const foreignBinding = refingerprintBinding({
      ...established,
      projectBindingId: foreignBindingId,
      projectId: foreignProjectId,
      vaultId: foreignVaultId,
      storeId: "77777777-7777-4777-8777-777777777777" as ProjectBinding["storeId"],
      workspaceId,
      storeRoute: {
        kind: "git-common",
        storeRoot,
        eventsPath: join(storeRoot, "events.sqlite"),
        storeManifestPath: join(storeRoot, "store-manifest.json"),
        projectionManifestPath: join(storeRoot, "current-projection.json"),
      },
      workspace,
    });
    const foreignContext: ProjectContext = {
      binding: foreignBinding,
      workspace: { ...workspace },
      checkedAt: "2026-07-13T00:00:02.000Z",
    };
    let executorCalls = 0;
    let recorderCalls = 0;
    const fake = dependencies({
      bindingService: {
        async establish() { return { ok: true, binding: established }; },
        async revalidate() { return foreignContext; },
      },
      executorFactory() {
        executorCalls += 1;
        const report = {
          ...QUICK_REPORT,
          projectId: foreignBinding.projectId,
          storeId: foreignBinding.storeId,
        };
        return {
          async open() { return {}; },
          async quickIntegrity() { return report; },
          async fullIntegrity() { return { ...report, mode: "full" }; },
          async close() {},
        };
      },
      integrityRecorder: {
        async record() { recorderCalls += 1; },
      },
    });
    const capture = outputCapture();

    assert.equal(await runCliCommand({
      ...defaultOptions("orchestrator-integrity"),
      projectRoot: roots.projectRoot,
      vault: roots.vaultRoot,
    }, capture.io, fake.value), 1);
    assert.equal(executorCalls, 0);
    assert.equal(recorderCalls, 0);
    assert.equal(capture.stdout(), "");
    assert.deepEqual(JSON.parse(capture.stderr()), {
      ok: false,
      code: "ORCHESTRATOR_ADMIN_FAILED",
      message: "Orchestrator administration failed",
    });
    assert.equal(capture.stderr().includes(foreignBindingId), false);
  });

  it("rejects a revalidated integrity context with a malformed checked timestamp", async () => {
    const roots = temporaryProject();
    const established = maintenanceBindingFor(roots);
    let executorCalls = 0;
    const fake = dependencies({
      bindingService: {
        async establish() { return { ok: true, binding: established }; },
        async revalidate() {
          return {
            ...contextForBinding(established),
            checkedAt: "INTEGRITY_CHECKED_AT_SECRET",
          };
        },
      },
      executorFactory() {
        executorCalls += 1;
        return {
          async open() { return {}; },
          async quickIntegrity() { return QUICK_REPORT; },
          async fullIntegrity() { return { ...QUICK_REPORT, mode: "full" }; },
          async close() {},
        };
      },
    });
    const capture = outputCapture();

    assert.equal(await runCliCommand({
      ...defaultOptions("orchestrator-integrity"),
      projectRoot: roots.projectRoot,
      vault: roots.vaultRoot,
    }, capture.io, fake.value), 1);
    assert.equal(executorCalls, 0);
    assert.equal(capture.stdout(), "");
    assert.deepEqual(JSON.parse(capture.stderr()), {
      ok: false,
      code: "ORCHESTRATOR_ADMIN_FAILED",
      message: "Orchestrator administration failed",
    });
    assert.equal(capture.stderr().includes("INTEGRITY_CHECKED_AT_SECRET"), false);
  });

  it("always closes an opened integrity executor when verification fails", async () => {
    const roots = temporaryProject();
    const fake = dependencies({
      executorFactory() {
        fake.calls.push("executor");
        return {
          async open() { fake.calls.push("open"); return {} as never; },
          async quickIntegrity() { fake.calls.push("quick"); throw new Error("secret failure"); },
          async fullIntegrity() { throw new Error("unused"); },
          async close() { fake.calls.push("close"); },
        };
      },
    });
    const capture = outputCapture();
    const code = await runCliCommand({
      ...defaultOptions("orchestrator-integrity"),
      projectRoot: roots.projectRoot,
      vault: roots.vaultRoot,
    }, capture.io, fake.value);
    assert.equal(code, 1);
    assert.deepEqual(fake.calls, [
      "client-id", "runtime", "establish:maintenance", "authority", "revalidate",
      "executor", "open", "quick", "close",
    ]);
    assert.equal(capture.stderr().includes("secret failure"), false);
  });

  it("closes the executor when open fails", async () => {
    const roots = temporaryProject();
    const fake = dependencies({
      executorFactory() {
        fake.calls.push("executor");
        return {
          async open() { fake.calls.push("open"); throw new Error("open secret"); },
          async quickIntegrity() { throw new Error("unused"); },
          async fullIntegrity() { throw new Error("unused"); },
          async close() { fake.calls.push("close"); },
        };
      },
    });
    const capture = outputCapture();
    assert.equal(await runCliCommand({
      ...defaultOptions("orchestrator-integrity"),
      projectRoot: roots.projectRoot,
      vault: roots.vaultRoot,
    }, capture.io, fake.value), 1);
    assert.deepEqual(fake.calls, [
      "client-id", "runtime", "establish:maintenance", "authority", "revalidate",
      "executor", "open", "close",
    ]);
    assert.equal(capture.stdout(), "");
    assert.equal(capture.stderr().includes("open secret"), false);
  });

  it("does not print a success result when executor close fails", async () => {
    const roots = temporaryProject();
    const fake = dependencies({
      executorFactory() {
        fake.calls.push("executor");
        return {
          async open() { fake.calls.push("open"); return {}; },
          async quickIntegrity() { fake.calls.push("quick"); return QUICK_REPORT; },
          async fullIntegrity() { throw new Error("unused"); },
          async close() { fake.calls.push("close"); throw new Error("close secret"); },
        };
      },
    });
    const capture = outputCapture();
    assert.equal(await runCliCommand({
      ...defaultOptions("orchestrator-integrity"),
      projectRoot: roots.projectRoot,
      vault: roots.vaultRoot,
    }, capture.io, fake.value), 1);
    assert.deepEqual(fake.calls.slice(-4), ["executor", "open", "quick", "close"]);
    assert.equal(capture.stdout(), "");
    assert.equal(capture.stderr().includes("close secret"), false);
  });

  for (const invalidReport of [
    {
      name: "foreign project identity",
      fullIntegrity: false,
      expectedCode: "PROJECT_ID_MISMATCH",
      mutate: (report: IntegrityReport): IntegrityReport => ({
        ...report,
        projectId: "99999999-9999-4999-8999-999999999999",
      }),
    },
    {
      name: "foreign store identity",
      fullIntegrity: false,
      expectedCode: "STORE_ID_MISMATCH",
      mutate: (report: IntegrityReport): IntegrityReport => ({
        ...report,
        storeId: "88888888-8888-4888-8888-888888888888",
      }),
    },
    {
      name: "quick report for a full request",
      fullIntegrity: true,
      expectedCode: "INTEGRITY_REPORT_INVALID",
      mutate: (report: IntegrityReport): IntegrityReport => ({ ...report, mode: "quick" }),
    },
    {
      name: "successful report with issues",
      fullIntegrity: false,
      expectedCode: "INTEGRITY_REPORT_INVALID",
      mutate: (report: IntegrityReport): IntegrityReport => ({
        ...report,
        ok: true,
        issues: [{
          code: "SQLITE_QUICK_CHECK_FAILED",
          message: "integrity issue",
        }],
      }),
    },
    {
      name: "failed report without issues",
      fullIntegrity: false,
      expectedCode: "INTEGRITY_REPORT_INVALID",
      mutate: (report: IntegrityReport): IntegrityReport => ({
        ...report,
        ok: false,
        issues: [],
      }),
    },
    {
      name: "dependency-owned issue serialization",
      fullIntegrity: false,
      expectedCode: "INTEGRITY_REPORT_INVALID",
      mutate: (report: IntegrityReport): IntegrityReport => ({
        ...report,
        ok: false,
        issues: [{
          code: "SQLITE_QUICK_CHECK_FAILED",
          message: {
            toJSON() { return "INTEGRITY_REPORT_SECRET"; },
          } as unknown as string,
        }],
      }),
    },
  ]) {
    it(`rejects an unbound integrity report: ${invalidReport.name}`, async () => {
      const roots = temporaryProject();
      const initialized = await new DefaultProjectStoreBootstrapService().initialize(roots);
      const workerUrl = new URL("../src/workers/project-store.worker.js", import.meta.url);
      const real = createOrchestratorAdminDependencies(workerUrl);
      const calls: string[] = [];
      const guardedDependencies: OrchestratorAdminDependencies = {
        ...real,
        executorFactory(context) {
          calls.push("executor");
          const expectedMode = invalidReport.fullIntegrity ? "full" : "quick";
          const report = invalidReport.mutate({
            ...QUICK_REPORT,
            mode: expectedMode,
            projectId: context.binding.projectId,
            storeId: context.binding.storeId,
          });
          return {
            async open() { calls.push("open"); return {}; },
            async quickIntegrity() { calls.push("quick"); return report; },
            async fullIntegrity() { calls.push("full"); return report; },
            async close() { calls.push("close"); },
          };
        },
      };
      const beforeManifest = readFileSync(initialized.route.storeManifestPath, "utf8");
      const capture = outputCapture();

      assert.equal(await runCliCommand({
        ...defaultOptions("orchestrator-integrity"),
        fullIntegrity: invalidReport.fullIntegrity,
        projectRoot: roots.projectRoot,
        vault: roots.vaultRoot,
      }, capture.io, guardedDependencies), 1);
      assert.equal(capture.stdout(), "");
      assert.equal(
        (JSON.parse(capture.stderr()) as { code: string }).code,
        invalidReport.expectedCode,
      );
      assert.equal(capture.stderr().includes("INTEGRITY_REPORT_SECRET"), false);
      assert.equal(
        readFileSync(initialized.route.storeManifestPath, "utf8"),
        beforeManifest,
      );
      assert.equal(calls.at(-1), "close");
    });
  }

  it("records failed integrity durably after close using the exact context and decoded report", async () => {
    const roots = temporaryProject();
    const failedReport: IntegrityReport = {
      ...QUICK_REPORT,
      ok: false,
      issues: [{
        code: "SQLITE_QUICK_CHECK_FAILED",
        message: "quick_check reported corruption",
      }],
    };
    let recordedContext: ProjectContext | undefined;
    let recordedReport: IntegrityReport | undefined;
    const fake = dependencies({
      executorFactory() {
        fake.calls.push("executor");
        return {
          async open() { fake.calls.push("open"); return {}; },
          async quickIntegrity() { fake.calls.push("quick"); return failedReport; },
          async fullIntegrity() { throw new Error("unused"); },
          async close() { fake.calls.push("close"); },
        };
      },
    });
    Object.assign(fake.value, {
      integrityRecorder: {
        async record(context: ProjectContext, report: IntegrityReport) {
          fake.calls.push("record");
          recordedContext = context;
          recordedReport = report;
        },
      },
    });
    const capture = outputCapture();
    assert.equal(await runCliCommand({
      ...defaultOptions("orchestrator-integrity"),
      projectRoot: roots.projectRoot,
      vault: roots.vaultRoot,
    }, capture.io, fake.value), 1);
    assert.deepEqual(fake.calls.slice(-5), ["executor", "open", "quick", "close", "record"]);
    assert.notEqual(recordedContext, CONTEXT);
    assert.deepEqual(recordedContext, contextForBinding(maintenanceBindingFor(roots)));
    assert.notEqual(recordedReport, failedReport);
    assert.deepEqual(recordedReport, failedReport);
    assert.deepEqual(JSON.parse(capture.stdout()), {
      action: "integrity",
      report: failedReport,
    });
    assert.equal(capture.stderr(), "");
  });

  it("reports manifest recording failure separately without losing the integrity report", async () => {
    const roots = temporaryProject();
    const fake = dependencies();
    Object.assign(fake.value, {
      integrityRecorder: {
        async record() {
          fake.calls.push("record");
          throw new Error("private manifest failure");
        },
      },
    });
    const capture = outputCapture();
    assert.equal(await runCliCommand({
      ...defaultOptions("orchestrator-integrity"),
      projectRoot: roots.projectRoot,
      vault: roots.vaultRoot,
    }, capture.io, fake.value), 1);
    assert.deepEqual(JSON.parse(capture.stdout()), {
      action: "integrity",
      report: QUICK_REPORT,
    });
    assert.deepEqual(JSON.parse(capture.stderr()), {
      ok: false,
      code: "INTEGRITY_RECORDING_FAILED",
      message: "Integrity completed but its manifest record could not be persisted",
    });
    assert.equal(capture.stderr().includes("private manifest failure"), false);
  });

  it("sanitizes blocked inspection messages and ignores hostile extra getters", async () => {
    const roots = temporaryProject();
    const summary = {
      projectRoot: roots.projectRoot,
      vaultRoot: roots.vaultRoot,
      routeState: "pending-project-identity" as const,
    };
    Object.defineProperty(summary, "workerData", {
      enumerable: true,
      get() { throw new Error("worker secret getter reached"); },
    });
    const fake = dependencies({
      async inspectInitialization() {
        return {
          state: "blocked",
          code: "PROJECT_ID_MISMATCH",
          message: "private mismatch details",
          summary,
          remediation: ["private remediation"],
        };
      },
    });
    const capture = outputCapture();
    assert.equal(await runCliCommand({
      ...defaultOptions("orchestrator-init"),
      projectRoot: roots.projectRoot,
      vault: roots.vaultRoot,
    }, capture.io, fake.value), 1);
    const output = capture.stderr();
    assert.equal(output.includes("private mismatch details"), false);
    assert.equal(output.includes("private remediation"), false);
    assert.equal(output.includes("worker secret"), false);
    assert.equal((JSON.parse(output) as { code: string }).code, "PROJECT_ID_MISMATCH");
  });

  it("classifies typed errors from one guarded discriminator snapshot", async () => {
    const roots = temporaryProject();
    const stateful = new ProjectStoreWorkerError("STORE_ID_MISMATCH", {
      privateDetails: "must-not-leak",
    });
    let codeReads = 0;
    Object.defineProperty(stateful, "code", {
      configurable: true,
      get() {
        codeReads += 1;
        if (codeReads === 1) return "STORE_ID_MISMATCH";
        if (codeReads === 2) return "private-second-value";
        throw new Error("private discriminator failure");
      },
    });
    const statefulFake = dependencies({
      executorFactory() {
        return {
          async open() { throw stateful; },
          async quickIntegrity() { throw new Error("unused"); },
          async fullIntegrity() { throw new Error("unused"); },
          async close() {},
        };
      },
    });
    const statefulOutput = outputCapture();
    assert.equal(await runCliCommand({
      ...defaultOptions("orchestrator-integrity"),
      projectRoot: roots.projectRoot,
      vault: roots.vaultRoot,
    }, statefulOutput.io, statefulFake.value), 1);
    assert.equal(codeReads, 1);
    assert.equal(
      (JSON.parse(statefulOutput.stderr()) as { code: string }).code,
      "STORE_ID_MISMATCH",
    );
    assert.equal(statefulOutput.stderr().includes("private"), false);

    const hostile = new Proxy({}, {
      getPrototypeOf() { throw new Error("private proxy prototype"); },
      get() { throw new Error("private proxy getter"); },
    });
    const hostileFake = dependencies({
      async runtimeProbe() { throw hostile; },
    });
    const hostileOutput = outputCapture();
    assert.equal(await runCliCommand({
      ...defaultOptions("orchestrator-status"),
      projectRoot: roots.projectRoot,
      vault: roots.vaultRoot,
    }, hostileOutput.io, hostileFake.value), 1);
    assert.equal(
      (JSON.parse(hostileOutput.stderr()) as { code: string }).code,
      "ORCHESTRATOR_ADMIN_FAILED",
    );
    assert.equal(hostileOutput.stderr().includes("private"), false);
  });

  it("does not echo an unknown usage discriminator from a proxied usage error", async () => {
    const roots = temporaryProject();
    const proxiedUsageError = new Proxy(
      new CliUsageError("PROJECT_ROOT_MISSING"),
      {
        get(target, property, receiver) {
          if (property === "code") return "USAGE_PROXY_SECRET";
          return Reflect.get(target, property, receiver);
        },
      },
    );
    const fake = dependencies({
      async runtimeProbe() { throw proxiedUsageError; },
    });
    const capture = outputCapture();

    assert.equal(await runCliCommand({
      ...defaultOptions("orchestrator-status"),
      projectRoot: roots.projectRoot,
      vault: roots.vaultRoot,
    }, capture.io, fake.value), 2);
    assert.deepEqual(JSON.parse(capture.stderr()), {
      ok: false,
      code: "INVALID_COMMAND_LINE_INPUT",
      message: "Invalid command-line input",
    });
    assert.equal(capture.stderr().includes("USAGE_PROXY_SECRET"), false);
  });

  it("does not retain a dependency-owned toJSON value in a blocked summary", async () => {
    const roots = temporaryProject();
    const fake = dependencies({
      async inspectInitialization() {
        return {
          state: "blocked",
          code: "PROJECT_ID_MISMATCH",
          message: "ignored",
          summary: {
            projectRoot: {
              toJSON() { return "SAFEADMIN_SUMMARY_SECRET"; },
            } as unknown as string,
            vaultRoot: roots.vaultRoot,
            routeState: "pending-project-identity",
          },
          remediation: [],
        };
      },
    });
    const capture = outputCapture();

    assert.equal(await runCliCommand({
      ...defaultOptions("orchestrator-init"),
      projectRoot: roots.projectRoot,
      vault: roots.vaultRoot,
    }, capture.io, fake.value), 1);
    assert.deepEqual(JSON.parse(capture.stderr()), {
      ok: false,
      code: "ORCHESTRATOR_ADMIN_FAILED",
      message: "Orchestrator administration failed",
    });
    assert.equal(capture.stderr().includes("SAFEADMIN_SUMMARY_SECRET"), false);
  });

  it("does not reject or disclose when a blocked summary toJSON throws", async () => {
    const roots = temporaryProject();
    const fake = dependencies({
      async inspectInitialization() {
        return {
          state: "blocked",
          code: "PROJECT_ID_MISMATCH",
          message: "ignored",
          summary: {
            projectRoot: {
              toJSON() { throw new Error("SAFEADMIN_TOJSON_SECRET"); },
            } as unknown as string,
            vaultRoot: roots.vaultRoot,
            routeState: "pending-project-identity",
          },
          remediation: [],
        };
      },
    });
    const capture = outputCapture();
    let exitCode: 0 | 1 | 2 | undefined;

    await assert.doesNotReject(async () => {
      exitCode = await runCliCommand({
        ...defaultOptions("orchestrator-init"),
        projectRoot: roots.projectRoot,
        vault: roots.vaultRoot,
      }, capture.io, fake.value);
    });
    assert.equal(exitCode, 1);
    assert.deepEqual(JSON.parse(capture.stderr()), {
      ok: false,
      code: "ORCHESTRATOR_ADMIN_FAILED",
      message: "Orchestrator administration failed",
    });
    assert.equal(capture.stderr().includes("SAFEADMIN_TOJSON_SECRET"), false);
  });

  it("uses the compiled one-shot identity worker and bound executor end to end", async () => {
    const roots = temporaryProject();
    const workerUrl = new URL("../src/workers/project-store.worker.js", import.meta.url);
    const real = createOrchestratorAdminDependencies(workerUrl);

    const initializedOutput = outputCapture();
    assert.equal(await runCliCommand({
      ...defaultOptions("orchestrator-init"),
      dryRun: false,
      projectRoot: roots.projectRoot,
      vault: roots.vaultRoot,
    }, initializedOutput.io, real), 0);
    const initialized = JSON.parse(initializedOutput.stdout()) as {
      result: {
        descriptor: { projectId: string; vaultId: string };
        manifest: { storeId: string };
        route: { eventsPath: string; storeManifestPath: string };
      };
    };

    const initializedInspectionOutput = outputCapture();
    assert.equal(await runCliCommand({
      ...defaultOptions("orchestrator-init"),
      projectRoot: roots.projectRoot,
      vault: roots.vaultRoot,
    }, initializedInspectionOutput.io, real), 0);
    assert.equal(
      (JSON.parse(initializedInspectionOutput.stdout()) as {
        inspection: { state: string };
      }).inspection.state,
      "initialized",
    );

    rmSync(initialized.result.route.storeManifestPath);
    const recoveryInspectionOutput = outputCapture();
    assert.equal(await runCliCommand({
      ...defaultOptions("orchestrator-init"),
      projectRoot: roots.projectRoot,
      vault: roots.vaultRoot,
    }, recoveryInspectionOutput.io, real), 0);
    const recoveryInspection = JSON.parse(recoveryInspectionOutput.stdout()) as {
      inspection: { state: string; summary: { storeId: string } };
    };
    assert.equal(recoveryInspection.inspection.state, "recoverable-manifest");
    assert.equal(recoveryInspection.inspection.summary.storeId, initialized.result.manifest.storeId);

    const recoveredOutput = outputCapture();
    assert.equal(await runCliCommand({
      ...defaultOptions("orchestrator-init"),
      dryRun: false,
      projectRoot: roots.projectRoot,
      vault: roots.vaultRoot,
    }, recoveredOutput.io, real), 0);
    assert.equal(
      (JSON.parse(recoveredOutput.stdout()) as {
        result: { recoveredManifest: boolean };
      }).result.recoveredManifest,
      true,
    );

    const statusOutput = outputCapture();
    assert.equal(await runCliCommand({
      ...defaultOptions("orchestrator-status"),
      projectRoot: roots.projectRoot,
      vault: roots.vaultRoot,
    }, statusOutput.io, real), 0);
    const status = JSON.parse(statusOutput.stdout()) as Record<string, unknown>;
    assert.equal(status.projectId, initialized.result.descriptor.projectId);
    assert.equal(status.vaultId, initialized.result.descriptor.vaultId);
    assert.equal(status.storeId, initialized.result.manifest.storeId);
    assert.equal(status.eventsPath, initialized.result.route.eventsPath);
    assert.equal("projectBindingId" in status, false);
    assert.equal("contextFingerprint" in status, false);

    const movedAfterProbe = `${initialized.result.route.eventsPath}.identity-closed`;
    renameSync(initialized.result.route.eventsPath, movedAfterProbe);
    renameSync(movedAfterProbe, initialized.result.route.eventsPath);

    const integrityOutput = outputCapture();
    assert.equal(await runCliCommand({
      ...defaultOptions("orchestrator-integrity"),
      projectRoot: roots.projectRoot,
      vault: roots.vaultRoot,
    }, integrityOutput.io, real), 0);
    const integrity = JSON.parse(integrityOutput.stdout()) as {
      report: {
        ok: boolean;
        mode: string;
        eventsVerified: number;
        schemaFingerprint: string;
        terminalEventHash: string;
      };
    };
    assert.equal(integrity.report.ok, true);
    assert.equal(integrity.report.mode, "quick");
    assert.equal(integrity.report.eventsVerified, 0);
    const recordedManifest = JSON.parse(
      readFileSync(initialized.result.route.storeManifestPath, "utf8"),
    ) as {
      lastIntegrity: {
        status: string;
        schemaFingerprint: string;
        terminalEventHash: string;
      };
    };
    assert.equal(recordedManifest.lastIntegrity.status, "passed");
    assert.equal(
      recordedManifest.lastIntegrity.schemaFingerprint,
      integrity.report.schemaFingerprint,
    );
    assert.equal(
      recordedManifest.lastIntegrity.terminalEventHash,
      integrity.report.terminalEventHash,
    );
    const database = new DatabaseSync(initialized.result.route.eventsPath, { readOnly: true });
    assert.equal(database.prepare("SELECT count(*) AS count FROM events").get()?.count, 0);
    database.close();
    const movedAfterIntegrity = `${initialized.result.route.eventsPath}.executor-closed`;
    renameSync(initialized.result.route.eventsPath, movedAfterIntegrity);
    renameSync(movedAfterIntegrity, initialized.result.route.eventsPath);
  });
});

describe("legacy CLI byte compatibility", () => {
  it("preserves validate and report stdout and exit codes", async () => {
    const roots = temporaryProject();
    const fake = dependencies();

    const validate = outputCapture();
    assert.equal(await runCliCommand(
      parseCliArgs(["validate", "--vault", roots.vaultRoot]),
      validate.io,
      fake.value,
    ), 0);
    assert.equal(validate.stdout(), `Frontmatter validation for ${roots.vaultRoot}
Files scanned: 0 | valid: 0 | with issues: 0
Severity: 0 critical, 0 error, 0 warning, 0 info
Auto-fixable files: 0 | blocked (manual): 0

No frontmatter issues found.
`);
    assert.equal(validate.stderr(), "");

    const report = outputCapture();
    assert.equal(await runCliCommand(
      parseCliArgs(["report", "--vault", roots.vaultRoot]),
      report.io,
      fake.value,
    ), 0);
    assert.equal(report.stdout(), `# Frontmatter Validation Report

- **Vault:** \`${roots.vaultRoot}\`
- **Files scanned:** 0
- **Valid files:** 0
- **Files with issues:** 0
- **Severity:** 0 critical / 0 error / 0 warning / 0 info
- **Auto-fixable files:** 0
- **Blocked (manual):** 0

No frontmatter issues found.
`);
    assert.equal(report.stderr(), "");
    assert.deepEqual(fake.calls, []);
  });

  it("preserves fix, migrate, and rollback JSON/text payloads", async () => {
    const roots = temporaryProject();
    const fake = dependencies();

    const fix = outputCapture();
    assert.equal(await runCliCommand(
      parseCliArgs(["fix", "--vault", roots.vaultRoot]),
      fix.io,
      fake.value,
    ), 0);
    assert.equal(fix.stdout(), `${JSON.stringify({
      vaultRoot: roots.vaultRoot,
      dryRun: true,
      unsafe: false,
      requiresConfirm: false,
      backupDir: null,
      scanned: 0,
      changed: 0,
      manual: 0,
      results: [],
    }, null, 2)}\n`);
    assert.equal(fix.stderr(), "");

    const migrate = outputCapture();
    assert.equal(await runCliCommand(
      parseCliArgs(["migrate", "--vault", roots.vaultRoot]),
      migrate.io,
      fake.value,
    ), 0);
    assert.equal(migrate.stdout(), `Frontmatter migration for ${roots.vaultRoot}
Target schema-version: 1 | DRY-RUN (no files written)
Scanned: 0 | would migrate: 0 | manual: 0

Nothing to migrate; all notes are already current.
`);
    assert.equal(migrate.stderr(), "");

    const rollback = outputCapture();
    assert.equal(await runCliCommand(
      parseCliArgs(["migrate", "--rollback", "--vault", roots.vaultRoot]),
      rollback.io,
      fake.value,
    ), 0);
    assert.equal(rollback.stdout(), `${JSON.stringify({
      vaultRoot: roots.vaultRoot,
      dryRun: true,
      backupDir: null,
      snapshotDir: null,
      restored: 0,
      results: [],
    }, null, 2)}\n`);
    assert.equal(rollback.stderr(), "");
    assert.deepEqual(fake.calls, []);
  });

  it("preserves legacy init creation and already-exists messages", async () => {
    const roots = temporaryProject();
    const fake = dependencies();
    const first = outputCapture();
    assert.equal(await runCliCommand(
      parseCliArgs(["init", "--vault", roots.vaultRoot]),
      first.io,
      fake.value,
    ), 0);
    assert.equal(first.stdout(), [
      `Created project frontmatter config: ${projectConfigPath(roots.vaultRoot)}\n`,
      `Created project frontmatter config schema: ${projectConfigSchemaPath(roots.vaultRoot)}\n`,
    ].join(""));

    const repeated = outputCapture();
    assert.equal(await runCliCommand(
      parseCliArgs(["init", "--vault", roots.vaultRoot]),
      repeated.io,
      fake.value,
    ), 0);
    assert.equal(repeated.stdout(), [
      `Project frontmatter config already exists: ${projectConfigPath(roots.vaultRoot)}\n`,
      `Project frontmatter config schema already exists: ${projectConfigSchemaPath(roots.vaultRoot)}\n`,
    ].join(""));
    assert.deepEqual(fake.calls, []);
  });

  it("preserves diagnose, unknown-command help, invalid-format, and warning stderr", async () => {
    const roots = temporaryProject();
    const fake = dependencies();

    const diagnose = outputCapture();
    assert.equal(await runCliCommand(parseCliArgs(["diagnose"]), diagnose.io, fake.value), 0);
    assert.equal(
      diagnose.stdout(),
      `${JSON.stringify(diagnoseMemoryConfig(process.env, process.cwd()), null, 2)}\n`,
    );

    const help = outputCapture();
    assert.equal(await runCliCommand(parseCliArgs(["unknown-command"]), help.io, fake.value), 0);
    assert.equal(help.stdout(), HELP);

    const invalid = outputCapture();
    assert.equal(await runCliCommand(
      parseCliArgs(["validate", "--format", "yaml", "--vault", roots.vaultRoot]),
      invalid.io,
      fake.value,
    ), 2);
    assert.equal(invalid.stdout(), "");
    assert.equal(
      invalid.stderr(),
      "Invalid --format 'yaml'. Use one of: text, json, markdown.\n",
    );

    const warning = outputCapture();
    assert.equal(await runCliCommand(
      parseCliArgs(["fix", "--apply", "--no-backup", "--vault", roots.vaultRoot]),
      warning.io,
      fake.value,
    ), 0);
    assert.equal(
      warning.stderr(),
      "Warning: --no-backup is ignored; a timestamped backup is always taken before writing.\n",
    );
    assert.deepEqual(fake.calls, []);
  });

  it("preserves the unsafe-without-confirm note", async () => {
    const roots = temporaryProject();
    const fake = dependencies();
    const capture = outputCapture();
    assert.equal(await runCliCommand(
      parseCliArgs(["fix", "--unsafe", "--vault", roots.vaultRoot]),
      capture.io,
      fake.value,
    ), 0);
    assert.equal(
      capture.stderr(),
      "Note: --unsafe requires --confirm; only safe fixes were applied.\n",
    );
    assert.equal(
      (JSON.parse(capture.stdout()) as { requiresConfirm: boolean }).requiresConfirm,
      true,
    );
    assert.deepEqual(fake.calls, []);
  });
});

describe("lazy SQLite administration loading", () => {
  it("keeps help available and maps V2 runtime failure without experimental SQLite", () => {
    const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));
    const help = spawnSync(process.execPath, [
      "--no-experimental-sqlite",
      cliPath,
      "help",
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(help.status, 0);
    assert.equal(help.stdout, HELP);
    assert.equal(help.stderr, "");

    const roots = temporaryProject();
    const status = spawnSync(process.execPath, [
      "--no-experimental-sqlite",
      cliPath,
      "orchestrator-status",
      "--project-root",
      roots.projectRoot,
      "--vault",
      roots.vaultRoot,
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(status.status, 1);
    assert.equal(status.stdout, "");
    assert.deepEqual(JSON.parse(status.stderr), {
      ok: false,
      code: "SQLITE_CAPABILITY_MISSING",
      message: "Required SQLite runtime capabilities are unavailable",
      remediation: [
        "run memory-vault diagnose and restore the required Node.js/SQLite runtime",
      ],
    });
  });
});

describe("V1 MCP isolation", () => {
  it("keeps app.ts and index.ts free of V2 CLI/runtime imports", () => {
    const app = readFileSync(resolve("src/app.ts"), "utf8");
    const index = readFileSync(resolve("src/index.ts"), "utf8");
    assert.equal(
      createHash("sha256").update(app.replace(/\r\n/g, "\n")).digest("hex"),
      "aa8d8c4edceedc0fe147f38e489a547bd8fbc84c9b0dc3d242933c158116c920",
    );
    assert.equal(
      createHash("sha256").update(index.replace(/\r\n/g, "\n")).digest("hex"),
      "55b3b498220f015044d89c4125c103df55f5bf23eae755637252698e63479fff",
    );
  });
});
