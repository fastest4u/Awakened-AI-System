import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";
import type {
  ProjectBinding,
  ProjectContext,
} from "../src/orchestrator/identity/contracts.js";
import type { TrustedProjectBindingRequest } from "../src/orchestrator/identity/project-binding.request.js";
import { ProjectDescriptorRepository } from "../src/orchestrator/identity/project-descriptor.repository.js";
import type { IntegrityReport } from "../src/orchestrator/integrity/integrity.types.js";
import type { RuntimeCapabilityReport } from "../src/orchestrator/runtime/runtime-capabilities.js";
import { DefaultProjectStoreBootstrapService } from "../src/orchestrator/storage/project-store-bootstrap.service.js";
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
} from "../src/cli/run-command.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryProject(): { projectRoot: string; vaultRoot: string } {
  const root = mkdtempSync(join(tmpdir(), "memory-cli-admin-"));
  temporaryRoots.push(root);
  const projectRoot = resolve(root, "project");
  const vaultRoot = resolve(projectRoot, "memory");
  mkdirSync(vaultRoot, { recursive: true });
  return { projectRoot, vaultRoot };
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

const CONTEXT = {
  binding: {
    projectBindingId: "private-binding-id",
    generation: 1,
    contextFingerprint: "private-context-fingerprint",
    source: "explicit-cli",
    projectId: "11111111-1111-4111-8111-111111111111",
    vaultId: "22222222-2222-4222-8222-222222222222",
    storeId: "33333333-3333-4333-8333-333333333333",
    workspaceId: "workspace-safe-id",
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
      workspaceId: "workspace-safe-id",
    },
    establishedAt: "2026-07-13T00:00:00.000Z",
  },
  workspace: {
    kind: "non-git",
    workspaceRoot: "C:\\explicit\\project",
    workspaceId: "workspace-safe-id",
  },
  checkedAt: "2026-07-13T00:00:01.000Z",
} as ProjectContext;

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
    bootstrap: {
      async initialize() {
        calls.push("bootstrap");
        throw new Error("bootstrap result must be supplied by the test");
      },
    },
    bindingService: {
      async establish(request: TrustedProjectBindingRequest) {
        calls.push(`establish:${request.actorRole}`);
        return { ok: true, binding: CONTEXT.binding };
      },
      async revalidate(binding: ProjectBinding) {
        assert.equal(binding, CONTEXT.binding);
        calls.push("revalidate");
        return CONTEXT;
      },
    },
    executorFactory(context: ProjectContext) {
      assert.equal(context, CONTEXT);
      calls.push("executor");
      return {
        async open() { calls.push("open"); return {} as never; },
        async quickIntegrity() { calls.push("quick"); return QUICK_REPORT; },
        async fullIntegrity() { calls.push("full"); return { ...QUICK_REPORT, mode: "full" }; },
        async close() { calls.push("close"); },
      };
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

  it("applies new initialization, recovers a missing manifest, and remains idempotent", async () => {
    const roots = temporaryProject();
    const bootstrap = new DefaultProjectStoreBootstrapService();
    const fake = dependencies({ bootstrap });

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
    const fake = dependencies({
      bootstrap: new DefaultProjectStoreBootstrapService(),
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

  it("establishes status as untrusted and emits only the safe projection", async () => {
    const roots = temporaryProject();
    const fake = dependencies();
    const capture = outputCapture();
    const code = await runCliCommand({
      ...defaultOptions("orchestrator-status"),
      projectRoot: roots.projectRoot,
      vault: roots.vaultRoot,
    }, capture.io, fake.value);
    assert.equal(code, 0);
    assert.deepEqual(fake.calls, ["client-id", "runtime", "establish:untrusted"]);
    const output = capture.stdout();
    assert.equal(output.includes("private-binding-id"), false);
    assert.equal(output.includes("private-context-fingerprint"), false);
    assert.equal(output.includes("private-client-id"), false);
    assert.deepEqual(JSON.parse(output), {
      action: "status",
      projectId: CONTEXT.binding.projectId,
      vaultId: CONTEXT.binding.vaultId,
      storeId: CONTEXT.binding.storeId,
      workspaceId: CONTEXT.binding.workspaceId,
      eventsPath: CONTEXT.binding.storeRoute.eventsPath,
      runtime: RUNTIME,
    });
  });

  it("passes the canonical explicit binding request with no inferred roots", async () => {
    const roots = temporaryProject();
    let observed: TrustedProjectBindingRequest | undefined;
    const fake = dependencies({
      bindingService: {
        async establish(request) {
          observed = request;
          return { ok: true, binding: CONTEXT.binding };
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
      "client-id", "runtime", "establish:maintenance", "revalidate",
      "executor", "open", "full", "close",
    ]);
    assert.deepEqual(JSON.parse(capture.stdout()), {
      action: "integrity",
      report: { ...QUICK_REPORT, mode: "full" },
    });
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
      "client-id", "runtime", "establish:maintenance", "revalidate",
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
      "client-id", "runtime", "establish:maintenance", "revalidate",
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
      report: { ok: boolean; mode: string; eventsVerified: number };
    };
    assert.equal(integrity.report.ok, true);
    assert.equal(integrity.report.mode, "quick");
    assert.equal(integrity.report.eventsVerified, 0);
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

describe("V1 MCP isolation", () => {
  it("keeps app.ts and index.ts free of V2 CLI/runtime imports", () => {
    const app = readFileSync(resolve("src/app.ts"), "utf8");
    const index = readFileSync(resolve("src/index.ts"), "utf8");
    assert.equal(
      createHash("sha256").update(app).digest("hex"),
      "1daf2c496807d73ddd35c4ff203581ca152cd445947afcd28e39fe888e08753f",
    );
    assert.equal(
      createHash("sha256").update(index).digest("hex"),
      "3cdd1f81d2a9eb5ab1be0c7af28ee2ef424e53555895c0fa716ed76d770aa4b0",
    );
  });
});
