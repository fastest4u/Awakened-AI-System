import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import type { ProjectContext } from "../src/orchestrator/identity/contracts.js";

type SourceStateModule = Readonly<Record<string, unknown>> & {
  readonly FilesystemSourceStateProvider?: new (options?: unknown) => {
    capture(context: ProjectContext, scope: unknown): Promise<unknown>;
    captureForCheckpoint(context: ProjectContext, scope: unknown): unknown;
    captureForFinalization(context: ProjectContext, scope: unknown): unknown;
  };
  readonly DeterministicSourceStateProvider?: new (value: unknown) => {
    capture(context: ProjectContext, scope: unknown): Promise<unknown>;
    captureForCheckpoint(context: ProjectContext, scope: unknown): unknown;
    captureForFinalization(context: ProjectContext, scope: unknown): unknown;
  };
  readonly SqliteSourceStateScopeResolver?: new (options: unknown) => {
    resolve(connection: unknown, context: ProjectContext): Readonly<Record<string, unknown>>;
  };
};

const temporaryRoots: string[] = [];

afterEach(() => {
  while (temporaryRoots.length !== 0) {
    rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
  }
});

async function optionalSourceStateModule(): Promise<SourceStateModule> {
  const moduleSpecifier = "../src/orchestrator/lifecycle/source-state.provider.js";
  try {
    return await import(moduleSpecifier) as SourceStateModule;
  } catch (error) {
    if (
      typeof error === "object"
      && error !== null
      && "code" in error
      && (error as { readonly code?: unknown }).code === "ERR_MODULE_NOT_FOUND"
    ) {
      class MissingSourceStateProvider {
        capture(context: ProjectContext): Promise<unknown> {
          return Promise.resolve(this.captureForCheckpoint(context));
        }

        captureForCheckpoint(context: ProjectContext): unknown {
          return Object.freeze({
            sourceStateScopeVersion: 1,
            workspaceId: context.workspace.workspaceId,
            branchRef: context.workspace.kind === "git" ? context.workspace.branchRef : null,
            headCommit: context.workspace.kind === "git" ? context.workspace.headCommit : null,
            dirtyWorktreeFingerprint: "0".repeat(64),
          });
        }

        captureForFinalization(context: ProjectContext): unknown {
          return this.captureForCheckpoint(context);
        }
      }
      return Object.freeze({ FilesystemSourceStateProvider: MissingSourceStateProvider });
    }
    throw error;
  }
}

function projectFixture(kind: "git" | "non-git"): {
  readonly context: ProjectContext;
  readonly scope: Readonly<Record<string, unknown>>;
  readonly projectRoot: string;
} {
  const projectRoot = mkdtempSync(join(tmpdir(), "source-state-v1-"));
  temporaryRoots.push(projectRoot);
  const vaultRoot = join(projectRoot, "memory");
  const descriptorPath = join(vaultRoot, ".project", "descriptor.json");
  const storeRoot = join(projectRoot, ".git", "project-memory", "project", "v2");
  const privateStateRoot = join(projectRoot, ".host-private");
  mkdirSync(join(vaultRoot, ".project"), { recursive: true });
  mkdirSync(storeRoot, { recursive: true });
  mkdirSync(privateStateRoot, { recursive: true });
  writeFileSync(descriptorPath, "{}\n", "utf8");
  const workspaceId = "a".repeat(64) as ProjectContext["workspace"]["workspaceId"];
  const workspace = kind === "git"
    ? {
        kind: "git" as const,
        worktreeRoot: projectRoot,
        gitDir: join(projectRoot, ".git"),
        gitCommonDir: join(projectRoot, ".git"),
        headCommit: "1".repeat(40),
        branchRef: "refs/heads/caller-stale",
        detached: false,
        workspaceId,
      }
    : {
        kind: "non-git" as const,
        workspaceRoot: projectRoot,
        workspaceId,
      };
  const context: ProjectContext = {
    binding: {
      projectBindingId: "binding-1",
      generation: 1,
      contextFingerprint: "b".repeat(64),
      source: "explicit-cli",
      projectId: "11111111-1111-4111-8111-111111111111" as ProjectContext["binding"]["projectId"],
      vaultId: "22222222-2222-4222-8222-222222222222" as ProjectContext["binding"]["vaultId"],
      storeId: "c".repeat(64) as ProjectContext["binding"]["storeId"],
      workspaceId,
      clientNamespace: "tests",
      clientInstanceId: "primary",
      actorRole: "primary",
      projectRoot,
      vaultRoot,
      descriptorPath,
      storeRoute: {
        kind: "git-common",
        storeRoot,
        eventsPath: join(storeRoot, "events.sqlite"),
        storeManifestPath: join(storeRoot, "store-manifest.json"),
        projectionManifestPath: join(storeRoot, "projection-manifest.json"),
      },
      workspace,
      establishedAt: "2026-07-18T00:00:00.000Z",
    },
    workspace,
    checkedAt: "2026-07-18T00:00:00.000Z",
  };
  return {
    context,
    projectRoot,
    scope: Object.freeze({
      scopeVersion: 1,
      descriptorPath,
      storeRoot,
      privateStateRoot,
      exactMaterializationTargets: Object.freeze([]),
      exactCommittedTempPaths: Object.freeze([]),
    }),
  };
}

function providerConstructor(module: SourceStateModule): NonNullable<SourceStateModule["FilesystemSourceStateProvider"]> {
  assert.equal(typeof module.FilesystemSourceStateProvider, "function");
  return module.FilesystemSourceStateProvider!;
}

describe("SourceStateProvider trusted capture", () => {
  it("uses only fixed bounded no-shell Git invocations and derives branch and HEAD", async () => {
    const module = await optionalSourceStateModule();
    const Provider = providerConstructor(module);
    const fixture = projectFixture("git");
    const invocations: Array<Readonly<Record<string, unknown>>> = [];
    const runner = {
      runSync(invocation: Readonly<Record<string, unknown>>) {
        invocations.push(invocation);
        const args = invocation.args as readonly string[];
        if (args.join(" ") === "symbolic-ref --quiet HEAD") {
          return { status: 0, stdout: "refs/heads/current\n", stderr: "" };
        }
        if (args.join(" ") === "rev-parse --verify HEAD") {
          return { status: 0, stdout: `${"2".repeat(40)}\n`, stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      async run(invocation: Readonly<Record<string, unknown>>) {
        return this.runSync(invocation);
      },
    };
    const provider = new Provider({ runner });

    const result = provider.captureForCheckpoint(fixture.context, fixture.scope) as {
      readonly branchRef: string | null;
      readonly headCommit: string | null;
    };

    assert.equal(result.branchRef, "refs/heads/current");
    assert.equal(result.headCommit, "2".repeat(40));
    assert.deepEqual(invocations.map((invocation) => invocation.args), [
      ["symbolic-ref", "--quiet", "HEAD"],
      ["rev-parse", "--verify", "HEAD"],
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    ]);
    for (const invocation of invocations) {
      assert.equal(invocation.executable, "git");
      assert.equal(invocation.cwd, fixture.projectRoot);
      assert.equal(invocation.shell, false);
      assert.equal(Object.hasOwn(invocation, "env"), false);
      assert.ok(typeof invocation.timeoutMs === "number" && invocation.timeoutMs > 0 && invocation.timeoutMs <= 5_000);
      assert.ok(typeof invocation.maxOutputBytes === "number" && invocation.maxOutputBytes > 0);
      assert.ok(Array.isArray(invocation.args));
    }
  });

  it("derives detached HEAD and produces a deterministic witness", async () => {
    const module = await optionalSourceStateModule();
    const Provider = providerConstructor(module);
    const fixture = projectFixture("git");
    const runner = {
      runSync(invocation: Readonly<Record<string, unknown>>) {
        const operation = (invocation.args as readonly string[]).join(" ");
        if (operation === "symbolic-ref --quiet HEAD") {
          return { status: 1, stdout: "", stderr: "" };
        }
        if (operation === "rev-parse --verify HEAD") {
          return { status: 0, stdout: `${"3".repeat(40)}\n`, stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      async run(invocation: Readonly<Record<string, unknown>>) {
        return this.runSync(invocation);
      },
    };
    const provider = new Provider({ runner });

    const first = provider.captureForCheckpoint(fixture.context, fixture.scope) as {
      readonly branchRef: string | null;
      readonly headCommit: string | null;
      readonly dirtyWorktreeFingerprint: string;
    };
    const second = await provider.capture(fixture.context, fixture.scope) as typeof first;

    assert.equal(first.branchRef, null);
    assert.equal(first.headCommit, "3".repeat(40));
    assert.equal(second.dirtyWorktreeFingerprint, first.dirtyWorktreeFingerprint);
  });

  it("distinguishes tracked, untracked, renamed, and deleted Git dirty states", async () => {
    const module = await optionalSourceStateModule();
    const Provider = providerConstructor(module);
    const fixture = projectFixture("git");
    const tracked = join(fixture.projectRoot, "tracked.txt");
    const untracked = join(fixture.projectRoot, "untracked.txt");
    const renamed = join(fixture.projectRoot, "renamed.txt");
    writeFileSync(tracked, "clean\n", "utf8");
    let statusOutput = "";
    let inventoryOutput = "tracked.txt\0";
    const runner = {
      runSync(invocation: Readonly<Record<string, unknown>>) {
        const operation = (invocation.args as readonly string[]).join(" ");
        if (operation === "symbolic-ref --quiet HEAD") {
          return { status: 0, stdout: "refs/heads/current\n", stderr: "" };
        }
        if (operation === "rev-parse --verify HEAD") {
          return { status: 0, stdout: `${"4".repeat(40)}\n`, stderr: "" };
        }
        if (operation === "status --porcelain=v1 -z --untracked-files=all") {
          return { status: 0, stdout: statusOutput, stderr: "" };
        }
        return { status: 0, stdout: inventoryOutput, stderr: "" };
      },
      async run(invocation: Readonly<Record<string, unknown>>) {
        return this.runSync(invocation);
      },
    };
    const provider = new Provider({ runner });
    const witness = () => (provider.captureForCheckpoint(fixture.context, fixture.scope) as {
      readonly dirtyWorktreeFingerprint: string;
    }).dirtyWorktreeFingerprint;
    const witnesses = [witness()];

    writeFileSync(tracked, "modified\n", "utf8");
    statusOutput = " M tracked.txt\0";
    witnesses.push(witness());

    writeFileSync(untracked, "new\n", "utf8");
    statusOutput = "?? untracked.txt\0";
    inventoryOutput = "tracked.txt\0untracked.txt\0";
    witnesses.push(witness());

    rmSync(untracked);
    renameSync(tracked, renamed);
    statusOutput = "R  renamed.txt\0tracked.txt\0";
    inventoryOutput = "renamed.txt\0";
    witnesses.push(witness());

    rmSync(renamed);
    statusOutput = " D renamed.txt\0";
    witnesses.push(witness());

    assert.equal(new Set(witnesses).size, witnesses.length);
  });

  it("captures a linked worktree while trusting its external Git-common store root", async () => {
    const module = await optionalSourceStateModule();
    const Provider = providerConstructor(module);
    const fixture = projectFixture("git");
    const gitCommonRoot = mkdtempSync(join(tmpdir(), "source-state-common-"));
    temporaryRoots.push(gitCommonRoot);
    const storeRoot = join(gitCommonRoot, "project-memory", "project", "v2");
    mkdirSync(storeRoot, { recursive: true });
    const workspace = Object.freeze({
      ...fixture.context.workspace,
      gitCommonDir: gitCommonRoot,
    }) as ProjectContext["workspace"];
    const context: ProjectContext = Object.freeze({
      ...fixture.context,
      workspace,
      binding: Object.freeze({
        ...fixture.context.binding,
        workspace,
        storeRoute: Object.freeze({
          ...fixture.context.binding.storeRoute,
          storeRoot,
          eventsPath: join(storeRoot, "events.sqlite"),
          storeManifestPath: join(storeRoot, "store-manifest.json"),
          projectionManifestPath: join(storeRoot, "projection-manifest.json"),
        }),
      }),
    });
    const observedCwds: string[] = [];
    const runner = {
      runSync(invocation: Readonly<Record<string, unknown>>) {
        observedCwds.push(invocation.cwd as string);
        const operation = (invocation.args as readonly string[]).join(" ");
        if (operation === "symbolic-ref --quiet HEAD") {
          return { status: 0, stdout: "refs/heads/linked\n", stderr: "" };
        }
        if (operation === "rev-parse --verify HEAD") {
          return { status: 0, stdout: `${"5".repeat(40)}\n`, stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      async run(invocation: Readonly<Record<string, unknown>>) {
        return this.runSync(invocation);
      },
    };
    const provider = new Provider({ runner });

    const result = provider.captureForCheckpoint(context, {
      ...fixture.scope,
      storeRoot,
    }) as { readonly branchRef: string | null };

    assert.equal(result.branchRef, "refs/heads/linked");
    assert.deepEqual(new Set(observedCwds), new Set([fixture.projectRoot]));
  });

  it("fails closed on timed-out and oversized Git command output", async () => {
    const module = await optionalSourceStateModule();
    const Provider = providerConstructor(module);
    const fixture = projectFixture("git");
    const timedOut = {
      runSync() {
        return { status: null, stdout: "", stderr: "", timedOut: true };
      },
      async run() {
        return this.runSync();
      },
    };
    const oversized = "x".repeat(4 * 1024 * 1024 + 1);
    const tooLarge = {
      runSync() {
        return { status: 0, stdout: oversized, stderr: "" };
      },
      async run() {
        return this.runSync();
      },
    };

    assert.throws(
      () => new Provider({ runner: timedOut }).captureForCheckpoint(fixture.context, fixture.scope),
      /INTEGRITY_FAILURE/u,
    );
    await assert.rejects(
      new Provider({ runner: tooLarge }).capture(fixture.context, fixture.scope),
      /INTEGRITY_FAILURE/u,
    );
  });

  it("changes a deterministic non-Git witness for an ordinary project edit", async () => {
    const module = await optionalSourceStateModule();
    const Provider = providerConstructor(module);
    const fixture = projectFixture("non-git");
    const ordinaryPath = join(fixture.projectRoot, "ordinary.txt");
    writeFileSync(ordinaryPath, "first\n", "utf8");
    const provider = new Provider();

    const first = provider.captureForCheckpoint(fixture.context, fixture.scope) as {
      readonly dirtyWorktreeFingerprint: string;
    };
    writeFileSync(ordinaryPath, "second\n", "utf8");
    const second = await provider.capture(fixture.context, fixture.scope) as {
      readonly dirtyWorktreeFingerprint: string;
    };

    assert.match(first.dirtyWorktreeFingerprint, /^[0-9a-f]{64}$/u);
    assert.match(second.dirtyWorktreeFingerprint, /^[0-9a-f]{64}$/u);
    assert.notEqual(second.dirtyWorktreeFingerprint, first.dirtyWorktreeFingerprint);
  });

  it("rejects an oversized non-Git file from metadata before reading it into memory", async () => {
    const module = await optionalSourceStateModule();
    const Provider = providerConstructor(module);
    const fixture = projectFixture("non-git");
    const oversized = join(fixture.projectRoot, "oversized.bin");
    writeFileSync(oversized, "", "utf8");
    truncateSync(oversized, 64 * 1024 * 1024 + 1);

    assert.throws(
      () => new Provider().captureForCheckpoint(fixture.context, fixture.scope),
      /INTEGRITY_FAILURE/u,
    );
  });

  it("fails closed when a path is replaced by an escaping junction between lstat and open", async () => {
    const module = await optionalSourceStateModule();
    const Provider = providerConstructor(module);
    const fixture = projectFixture("non-git");
    const outside = mkdtempSync(join(tmpdir(), "source-state-outside-"));
    temporaryRoots.push(outside);
    const insideDirectory = join(fixture.projectRoot, "inside");
    const displacedDirectory = join(fixture.projectRoot, "inside-before-swap");
    const target = join(insideDirectory, "target.txt");
    mkdirSync(insideDirectory);
    writeFileSync(target, "trusted\n", "utf8");
    writeFileSync(join(outside, "target.txt"), "outside\n", "utf8");
    let swapped = false;
    const provider = new Provider({
      faultInjector: (point: unknown, path: unknown) => {
        if (point === "after-lstat-before-open" && path === target) {
          renameSync(insideDirectory, displacedDirectory);
          symlinkSync(outside, insideDirectory, "junction");
          swapped = true;
        }
      },
    });

    assert.throws(
      () => provider.captureForCheckpoint(fixture.context, fixture.scope),
      /INTEGRITY_FAILURE/u,
    );
    assert.equal(swapped, true);
  });

  it("provides an injected deterministic fake for transactional tests", async () => {
    const module = await optionalSourceStateModule();
    assert.equal(typeof module.DeterministicSourceStateProvider, "function");
    const fixture = projectFixture("non-git");
    const value = Object.freeze({
      sourceStateScopeVersion: 1,
      workspaceId: fixture.context.workspace.workspaceId,
      branchRef: null,
      headCommit: null,
      dirtyWorktreeFingerprint: "6".repeat(64),
    });
    const provider = new module.DeterministicSourceStateProvider!(value);

    assert.deepEqual(provider.captureForCheckpoint(fixture.context, fixture.scope), value);
    assert.deepEqual(provider.captureForFinalization(fixture.context, fixture.scope), value);
    assert.deepEqual(await provider.capture(fixture.context, fixture.scope), value);
  });

  it("rejects unknown provider options instead of accepting caller command fields", async () => {
    const module = await optionalSourceStateModule();
    const Provider = providerConstructor(module);

    assert.throws(() => new Provider({
      executable: "caller-selected",
    }), /LIFECYCLE_INPUT_INVALID/u);
  });

  it("rejects whole-log-directory and arbitrary caller-selected exclusions", async () => {
    const module = await optionalSourceStateModule();
    const Provider = providerConstructor(module);
    const fixture = projectFixture("non-git");
    const provider = new Provider();
    const logDirectory = join(fixture.context.binding.vaultRoot, "05_Agent_Session_Logs");
    mkdirSync(logDirectory, { recursive: true });
    const scope = fixture.scope;

    assert.throws(() => provider.captureForCheckpoint(fixture.context, {
      ...scope,
      exactMaterializationTargets: [logDirectory],
    }), /LIFECYCLE_INPUT_INVALID/u);
    assert.throws(() => provider.captureForCheckpoint(fixture.context, {
      ...scope,
      exactMaterializationTargets: [join(fixture.projectRoot, "ordinary.txt")],
    }), /LIFECYCLE_INPUT_INVALID/u);
    assert.throws(() => provider.captureForCheckpoint(fixture.context, {
      ...scope,
      exactCommittedTempPaths: [join(logDirectory, ".caller-selected.tmp")],
    }), /LIFECYCLE_INPUT_INVALID/u);
    assert.throws(() => provider.captureForCheckpoint(fixture.context, {
      ...scope,
      excludeGlobs: ["**/*"],
    }), /LIFECYCLE_INPUT_INVALID/u);
  });

  it("excludes only exact system targets and matching committed temp paths", async () => {
    const module = await optionalSourceStateModule();
    const Provider = providerConstructor(module);
    const fixture = projectFixture("non-git");
    const provider = new Provider();
    const sessionId = "33333333-3333-4333-8333-333333333333";
    const logDirectory = join(fixture.context.binding.vaultRoot, "05_Agent_Session_Logs");
    const target = join(logDirectory, `2026-07-18-session-${sessionId}.md`);
    const temp = join(
      logDirectory,
      `.2026-07-18-session-${sessionId}.md.pm-materialize-${sessionId}-7-3.tmp`,
    );
    const ordinaryLog = join(logDirectory, "ordinary-note.md");
    const storeFile = join(fixture.context.binding.storeRoute.storeRoot, "events.sqlite-wal");
    const privateFile = join(fixture.scope.privateStateRoot as string, "pending.bin");
    mkdirSync(logDirectory, { recursive: true });
    writeFileSync(target, "ending\n", "utf8");
    writeFileSync(temp, "staged\n", "utf8");
    writeFileSync(storeFile, "store-1\n", "utf8");
    writeFileSync(privateFile, "private-1\n", "utf8");
    writeFileSync(ordinaryLog, "ordinary-1\n", "utf8");
    const scope = {
      ...fixture.scope,
      exactMaterializationTargets: [target],
      exactCommittedTempPaths: [temp],
    };

    const baseline = provider.captureForCheckpoint(fixture.context, scope) as {
      readonly dirtyWorktreeFingerprint: string;
    };
    writeFileSync(target, "completed\n", "utf8");
    writeFileSync(temp, "restaged\n", "utf8");
    writeFileSync(storeFile, "store-2\n", "utf8");
    writeFileSync(privateFile, "private-2\n", "utf8");
    writeFileSync(fixture.context.binding.descriptorPath, "{\"revision\":2}\n", "utf8");
    const afterSystemWrites = provider.captureForFinalization(fixture.context, scope) as {
      readonly dirtyWorktreeFingerprint: string;
    };
    assert.equal(afterSystemWrites.dirtyWorktreeFingerprint, baseline.dirtyWorktreeFingerprint);

    writeFileSync(ordinaryLog, "ordinary-2\n", "utf8");
    const afterOrdinaryEdit = await provider.capture(fixture.context, scope) as {
      readonly dirtyWorktreeFingerprint: string;
    };
    assert.notEqual(afterOrdinaryEdit.dirtyWorktreeFingerprint, baseline.dirtyWorktreeFingerprint);
  });

  it("derives compatibility targets and temp claim tuples only from committed rows", async () => {
    const module = await optionalSourceStateModule();
    assert.equal(typeof module.SqliteSourceStateScopeResolver, "function");
    const fixture = projectFixture("non-git");
    const sessionId = "33333333-3333-4333-8333-333333333333";
    const artifactPath = `05_Agent_Session_Logs/2026-07-18-session-${sessionId}.md`;
    let committedArtifactPath = artifactPath;
    const connection = {
      prepare(sql: string) {
        return {
          all() {
            if (sql.includes("FROM events")) {
              return [{ session_id: sessionId, occurred_at: "2026-07-18T04:05:06.007Z" }];
            }
            if (sql.includes("FROM outbox")) {
              return [{
                session_id: sessionId,
                artifact_path: committedArtifactPath,
                materialization_revision: 7n,
                status: "claimed",
                claim_owner: "worker-1",
                claim_token: 3n,
              }];
            }
            throw new Error("unexpected statement");
          },
        };
      },
    };
    const resolver = new module.SqliteSourceStateScopeResolver!({
      privateStateRoot: fixture.scope.privateStateRoot,
    });

    const scope = resolver.resolve(connection, fixture.context);

    assert.deepEqual(scope.exactMaterializationTargets, [join(fixture.context.binding.vaultRoot, artifactPath)]);
    assert.deepEqual(scope.exactCommittedTempPaths, [join(
      fixture.context.binding.vaultRoot,
      "05_Agent_Session_Logs",
      `.2026-07-18-session-${sessionId}.md.pm-materialize-${sessionId}-7-3.tmp`,
    )]);

    committedArtifactPath = `05_Agent_Session_Logs/2026-07-18-session-${"4".repeat(8)}-4444-4444-8444-444444444444.md`;
    assert.throws(
      () => resolver.resolve(connection, fixture.context),
      /INTEGRITY_FAILURE/u,
    );
  });
});
