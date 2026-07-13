import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { ProjectDescriptorV1, ProjectId, VaultId } from "../src/orchestrator/identity/contracts.js";
import {
  GitWorkspaceResolutionError,
  GitWorkspaceResolver,
  SpawnSyncGitCommandRunner,
  type GitCommandResult,
  type GitCommandRunner,
} from "../src/orchestrator/identity/git-workspace.resolver.js";

const descriptor: ProjectDescriptorV1 = {
  schemaVersion: 1,
  projectId: "11111111-1111-4111-8111-111111111111" as ProjectId,
  vaultId: "22222222-2222-4222-8222-222222222222" as VaultId,
  createdAt: "2026-07-11T00:00:00.000Z",
};

const notRepositoryDiagnostic =
  "fatal: not a git repository (or any of the parent directories): .git\n";
const unbornHeadDiagnostic = [
  "fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree.",
  "Use '--' to separate paths from revisions, like this:",
  "'git <command> [<revision>...] -- [<file>...]'",
  "",
].join("\n");

function runGitFixtureSetup(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  const diagnostic = result.stderr || result.error?.message || "git exited without diagnostics";
  assert.equal(result.status, 0, `${args.join(" ")}: ${diagnostic}`);
}

describe("GitWorkspaceResolver", () => {
  let root: string | undefined;

  afterEach(() => {
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it("records a normal checkout's canonical Git identity", () => {
    root = mkdtempSync(join(tmpdir(), "memory-git-workspace-"));
    const projectRoot = join(root, "checkout");
    const gitDir = join(projectRoot, ".git");
    mkdirSync(gitDir, { recursive: true });
    const outputs: Record<string, string> = {
      "rev-parse --show-toplevel": `${projectRoot}\n`,
      "rev-parse --path-format=absolute --absolute-git-dir": `${gitDir}\n`,
      "rev-parse --path-format=absolute --git-common-dir": `${gitDir}\n`,
      "rev-parse HEAD": "0123456789abcdef0123456789abcdef01234567\n",
      "symbolic-ref -q HEAD": "refs/heads/feature/a\n",
    };
    const calls: Array<{ cwd: string; args: string[] }> = [];
    const runner: GitCommandRunner = {
      run(cwd: string, args: string[]) {
        calls.push({ cwd, args: [...args] });
        const stdout = outputs[args.join(" ")];
        return stdout === undefined
          ? { exitCode: 1, stdout: "", stderr: "unexpected args" }
          : { exitCode: 0, stdout, stderr: "" };
      },
    };

    const snapshot = new GitWorkspaceResolver(runner).inspect(projectRoot, descriptor);

    assert.equal(snapshot.kind, "git");
    if (snapshot.kind !== "git") return;
    assert.equal(snapshot.worktreeRoot, resolve(realpathSync.native(projectRoot)));
    assert.equal(snapshot.gitDir, resolve(realpathSync.native(gitDir)));
    assert.equal(snapshot.gitCommonDir, resolve(realpathSync.native(gitDir)));
    assert.equal(snapshot.headCommit, "0123456789abcdef0123456789abcdef01234567");
    assert.equal(snapshot.branchRef, "refs/heads/feature/a");
    assert.equal(snapshot.detached, false);
    assert.match(snapshot.workspaceId, /^[0-9a-f]{64}$/);
    assert.deepEqual(calls, [
      { cwd: projectRoot, args: ["rev-parse", "--show-toplevel"] },
      { cwd: projectRoot, args: ["rev-parse", "--path-format=absolute", "--absolute-git-dir"] },
      { cwd: projectRoot, args: ["rev-parse", "--path-format=absolute", "--git-common-dir"] },
      { cwd: projectRoot, args: ["rev-parse", "HEAD"] },
      { cwd: projectRoot, args: ["symbolic-ref", "-q", "HEAD"] },
    ]);
  });

  it("represents an empty symbolic-ref result as detached HEAD", () => {
    root = mkdtempSync(join(tmpdir(), "memory-git-detached-"));
    const projectRoot = join(root, "checkout");
    const gitDir = join(projectRoot, ".git");
    mkdirSync(gitDir, { recursive: true });
    const outputs: Record<string, string> = {
      "rev-parse --show-toplevel": `${projectRoot}\n`,
      "rev-parse --path-format=absolute --absolute-git-dir": `${gitDir}\n`,
      "rev-parse --path-format=absolute --git-common-dir": `${gitDir}\n`,
      "rev-parse HEAD": "fedcba9876543210fedcba9876543210fedcba98\n",
    };
    const runner: GitCommandRunner = {
      run(_cwd: string, args: string[]) {
        if (args.join(" ") === "symbolic-ref -q HEAD") {
          return { exitCode: 1, stdout: "", stderr: "" };
        }
        return { exitCode: 0, stdout: outputs[args.join(" ")]!, stderr: "" };
      },
    };

    const snapshot = new GitWorkspaceResolver(runner).inspect(projectRoot, descriptor);

    assert.equal(snapshot.kind, "git");
    if (snapshot.kind !== "git") return;
    assert.equal(snapshot.branchRef, null);
    assert.equal(snapshot.detached, true);
    assert.equal(snapshot.headCommit, "fedcba9876543210fedcba9876543210fedcba98");
  });

  it("returns a non-Git snapshot only for Git's not-a-repository diagnostic", () => {
    root = mkdtempSync(join(tmpdir(), "memory-non-git-"));
    const projectRoot = join(root, "plain project");
    mkdirSync(projectRoot);
    const calls: Array<{ cwd: string; args: string[] }> = [];
    const runner: GitCommandRunner = {
      run(cwd: string, args: string[]) {
        calls.push({ cwd, args });
        return {
          exitCode: 128,
          stdout: "",
          stderr: notRepositoryDiagnostic,
        };
      },
    };

    const snapshot = new GitWorkspaceResolver(runner).inspect(projectRoot, descriptor);

    assert.deepEqual(snapshot, {
      kind: "non-git",
      workspaceRoot: resolve(realpathSync.native(projectRoot)),
      workspaceId: snapshot.workspaceId,
    });
    assert.match(snapshot.workspaceId, /^[0-9a-f]{64}$/);
    assert.deepEqual(calls, [{ cwd: projectRoot, args: ["rev-parse", "--show-toplevel"] }]);
    assert.equal("gitDir" in snapshot, false);
    assert.equal("gitCommonDir" in snapshot, false);
  });

  for (const [caseName, failure] of [
    ["the not-a-repository diagnostic has the wrong exit status", {
      exitCode: 1,
      stdout: "",
      stderr: notRepositoryDiagnostic,
    }],
    ["the not-a-repository diagnostic has an extra prefix", {
      exitCode: 128,
      stdout: "",
      stderr: `unexpected prefix\n${notRepositoryDiagnostic}`,
    }],
    ["the not-a-repository diagnostic has an extra suffix", {
      exitCode: 128,
      stdout: "",
      stderr: `${notRepositoryDiagnostic}unexpected suffix\n`,
    }],
    ["a permission diagnostic is mixed with not-a-repository text", {
      exitCode: 128,
      stdout: "",
      stderr: `fatal: cannot open repository: Permission denied\n${notRepositoryDiagnostic}`,
    }],
    ["a dubious-ownership diagnostic is mixed with not-a-repository text", {
      exitCode: 128,
      stdout: "",
      stderr: `fatal: detected dubious ownership in repository\n${notRepositoryDiagnostic}`,
    }],
  ] satisfies Array<[string, GitCommandResult]>) {
    it(`fails closed when ${caseName}`, () => {
      root = mkdtempSync(join(tmpdir(), "memory-git-non-repo-lookalike-"));
      const runner: GitCommandRunner = { run: () => failure };

      assert.throws(
        () => new GitWorkspaceResolver(runner).inspect(root!, descriptor),
        (error: unknown) => error instanceof GitWorkspaceResolutionError
          && error.code === "GIT_PROBE_FAILED",
      );
    });
  }

  it("fails closed with a typed probe error when Git cannot execute", () => {
    root = mkdtempSync(join(tmpdir(), "memory-git-missing-"));
    const failures: GitCommandResult[] = [
      { exitCode: 1, stdout: "", stderr: "spawnSync git ENOENT" },
      { exitCode: 1, stdout: "", stderr: "spawnSync git ETIMEDOUT" },
      { exitCode: 1, stdout: "", stderr: "spawnSync git EACCES" },
      { exitCode: 128, stdout: "", stderr: "fatal: detected dubious ownership in repository" },
    ];
    for (const failure of failures) {
      const runner: GitCommandRunner = { run: () => failure };
      assert.throws(
        () => new GitWorkspaceResolver(runner).inspect(root!, descriptor),
        (error: unknown) => {
          assert.ok(error instanceof GitWorkspaceResolutionError);
          assert.equal(error.code, "GIT_PROBE_FAILED");
          return true;
        },
      );
    }
  });

  it("throws a typed not-ready error for an unborn symbolic HEAD", () => {
    root = mkdtempSync(join(tmpdir(), "memory-git-unborn-"));
    const projectRoot = join(root, "checkout");
    const gitDir = join(projectRoot, ".git");
    mkdirSync(gitDir, { recursive: true });
    const calls: string[] = [];
    const runner: GitCommandRunner = {
      run(_cwd: string, args: string[]) {
        const key = args.join(" ");
        calls.push(key);
        const outputs: Record<string, GitCommandResult> = {
          "rev-parse --show-toplevel": { exitCode: 0, stdout: `${projectRoot}\n`, stderr: "" },
          "rev-parse --path-format=absolute --absolute-git-dir": {
            exitCode: 0,
            stdout: `${gitDir}\n`,
            stderr: "",
          },
          "rev-parse --path-format=absolute --git-common-dir": {
            exitCode: 0,
            stdout: `${gitDir}\n`,
            stderr: "",
          },
          "rev-parse HEAD": {
            exitCode: 128,
            stdout: "HEAD\n",
            stderr: unbornHeadDiagnostic,
          },
          "symbolic-ref -q HEAD": {
            exitCode: 0,
            stdout: "refs/heads/main\n",
            stderr: "",
          },
        };
        return outputs[key]!;
      },
    };

    assert.throws(
      () => new GitWorkspaceResolver(runner).inspect(projectRoot, descriptor),
      (error: unknown) => {
        assert.ok(error instanceof GitWorkspaceResolutionError);
        assert.equal(error.code, "GIT_WORKSPACE_NOT_READY");
        assert.equal(error.reason, "UNBORN_HEAD");
        return true;
      },
    );
    assert.deepEqual(calls, [
      "rev-parse --show-toplevel",
      "rev-parse --path-format=absolute --absolute-git-dir",
      "rev-parse --path-format=absolute --git-common-dir",
      "rev-parse HEAD",
      "symbolic-ref -q HEAD",
    ]);
  });

  it("classifies a real unborn repository through SpawnSync as not ready", () => {
    root = mkdtempSync(join(tmpdir(), "memory-git-real-unborn-"));
    const projectRoot = join(root, "unborn repository");
    mkdirSync(projectRoot);
    const runner = new SpawnSyncGitCommandRunner();
    const initResult = runner.run(projectRoot, ["init", "--quiet"]);
    assert.equal(initResult.exitCode, 0, initResult.stderr);

    assert.deepEqual(runner.run(projectRoot, ["rev-parse", "HEAD"]), {
      exitCode: 128,
      stdout: "HEAD\n",
      stderr: unbornHeadDiagnostic,
    });
    assert.throws(
      () => new GitWorkspaceResolver(runner).inspect(projectRoot, descriptor),
      (error: unknown) => error instanceof GitWorkspaceResolutionError
        && error.code === "GIT_WORKSPACE_NOT_READY"
        && error.reason === "UNBORN_HEAD",
    );
  });

  for (const [caseName, headFailure] of [
    ["the unborn-HEAD diagnostic has the wrong exit status", {
      exitCode: 1,
      stdout: "HEAD\n",
      stderr: unbornHeadDiagnostic,
    }],
    ["the unborn-HEAD diagnostic has an extra prefix", {
      exitCode: 128,
      stdout: "HEAD\n",
      stderr: `unexpected prefix\n${unbornHeadDiagnostic}`,
    }],
    ["the unborn-HEAD diagnostic has an extra suffix", {
      exitCode: 128,
      stdout: "HEAD\n",
      stderr: `${unbornHeadDiagnostic}unexpected suffix\n`,
    }],
    ["a permission diagnostic is mixed with unborn-HEAD text", {
      exitCode: 128,
      stdout: "HEAD\n",
      stderr: `fatal: cannot read HEAD: Permission denied\n${unbornHeadDiagnostic}`,
    }],
    ["a dubious-ownership diagnostic is mixed with unborn-HEAD text", {
      exitCode: 128,
      stdout: "HEAD\n",
      stderr: `fatal: detected dubious ownership in repository\n${unbornHeadDiagnostic}`,
    }],
  ] satisfies Array<[string, GitCommandResult]>) {
    it(`fails closed when ${caseName}`, () => {
      root = mkdtempSync(join(tmpdir(), "memory-git-unborn-lookalike-"));
      const projectRoot = join(root, "checkout");
      const gitDir = join(projectRoot, ".git");
      mkdirSync(gitDir, { recursive: true });
      const results: Record<string, GitCommandResult> = {
        "rev-parse --show-toplevel": {
          exitCode: 0,
          stdout: `${projectRoot}\n`,
          stderr: "",
        },
        "rev-parse --path-format=absolute --absolute-git-dir": {
          exitCode: 0,
          stdout: `${gitDir}\n`,
          stderr: "",
        },
        "rev-parse --path-format=absolute --git-common-dir": {
          exitCode: 0,
          stdout: `${gitDir}\n`,
          stderr: "",
        },
        "rev-parse HEAD": headFailure,
        "symbolic-ref -q HEAD": {
          exitCode: 0,
          stdout: "refs/heads/main\n",
          stderr: "",
        },
      };
      const runner: GitCommandRunner = {
        run(_cwd: string, args: string[]) {
          return results[args.join(" ")]!;
        },
      };

      assert.throws(
        () => new GitWorkspaceResolver(runner).inspect(projectRoot, descriptor),
        (error: unknown) => error instanceof GitWorkspaceResolutionError
          && error.code === "GIT_PROBE_FAILED",
      );
    });
  }

  it("reports malformed Git path output as a typed probe failure", () => {
    root = mkdtempSync(join(tmpdir(), "memory-git-malformed-"));
    const runner: GitCommandRunner = {
      run() {
        return { exitCode: 0, stdout: "\n", stderr: "" };
      },
    };

    assert.throws(
      () => new GitWorkspaceResolver(runner).inspect(root!, descriptor),
      (error: unknown) => {
        assert.ok(error instanceof GitWorkspaceResolutionError);
        assert.equal(error.code, "GIT_PROBE_FAILED");
        assert.equal(error.reason, "MALFORMED_OUTPUT");
        return true;
      },
    );
  });

  it("fails closed when a path probe emits an existing relative directory", () => {
    root = mkdtempSync(join(tmpdir(), "memory-git-relative-path-"));
    const projectRoot = join(root, "checkout");
    const gitDir = join(projectRoot, ".git");
    mkdirSync(gitDir, { recursive: true });
    const outputs: Record<string, string> = {
      "rev-parse --show-toplevel": ".\n",
      "rev-parse --path-format=absolute --absolute-git-dir": `${gitDir}\n`,
      "rev-parse --path-format=absolute --git-common-dir": `${gitDir}\n`,
      "rev-parse HEAD": "0123456789abcdef0123456789abcdef01234567\n",
      "symbolic-ref -q HEAD": "refs/heads/main\n",
    };
    const runner: GitCommandRunner = {
      run(_cwd: string, args: string[]) {
        return { exitCode: 0, stdout: outputs[args.join(" ")]!, stderr: "" };
      },
    };

    assert.throws(
      () => new GitWorkspaceResolver(runner).inspect(projectRoot, descriptor),
      (error: unknown) => error instanceof GitWorkspaceResolutionError
        && error.code === "GIT_PROBE_FAILED"
        && error.reason === "MALFORMED_OUTPUT",
    );
  });

  it("passes Git arguments as argv without shell expansion", () => {
    root = mkdtempSync(join(tmpdir(), "memory-git-runner-"));
    const sentinel = join(root, "shell-expanded.txt");

    const result = new SpawnSyncGitCommandRunner().run(root, [
      "--version",
      "&",
      "cmd",
      "/c",
      "echo",
      "expanded",
      ">",
      sentinel,
    ]);

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /^git version /);
    assert.equal(existsSync(sentinel), false);
  });

  it("gives linked worktrees with spaces and Thai segments distinct stable identities", () => {
    root = mkdtempSync(join(tmpdir(), "memory-git-linked-"));
    const projectRoot = join(root, "โครงการ source repo");
    const linkedRoot = join(root, "สำเนา linked worktree");
    mkdirSync(projectRoot);
    const git = new SpawnSyncGitCommandRunner();
    runGitFixtureSetup(projectRoot, ["init", "--quiet"]);
    runGitFixtureSetup(projectRoot, ["config", "user.email", "resolver@example.invalid"]);
    runGitFixtureSetup(projectRoot, ["config", "user.name", "Resolver Test"]);
    writeFileSync(join(projectRoot, "README.md"), "linked worktree fixture\n");
    runGitFixtureSetup(projectRoot, ["add", "README.md"]);
    runGitFixtureSetup(projectRoot, ["commit", "--quiet", "-m", "initial"]);
    runGitFixtureSetup(projectRoot, ["worktree", "add", "--quiet", "-b", "feature/linked", linkedRoot]);

    const main = new GitWorkspaceResolver(git).inspect(projectRoot, descriptor);
    const linked = new GitWorkspaceResolver(git).inspect(linkedRoot, descriptor);

    assert.equal(main.kind, "git");
    assert.equal(linked.kind, "git");
    if (main.kind !== "git" || linked.kind !== "git") return;
    assert.equal(main.worktreeRoot, resolve(realpathSync.native(projectRoot)));
    assert.equal(linked.worktreeRoot, resolve(realpathSync.native(linkedRoot)));
    assert.equal(main.gitCommonDir, linked.gitCommonDir);
    assert.notEqual(main.gitDir, linked.gitDir);
    assert.notEqual(main.workspaceId, linked.workspaceId);
    assert.equal(linked.branchRef, "refs/heads/feature/linked");
    assert.equal(linked.headCommit, main.headCommit);
  });

  it("canonicalizes Windows drive-case drift and UNC Git paths deterministically", { skip: process.platform !== "win32" }, () => {
    root = mkdtempSync(join(tmpdir(), "memory-git-windows-paths-"));
    const localProjectRoot = join(root, "พื้นที่ project");
    const localGitDir = join(localProjectRoot, ".git");
    mkdirSync(localGitDir, { recursive: true });
    const resolveWith = (projectRoot: string, gitDir: string): ReturnType<GitWorkspaceResolver["inspect"]> => {
      const outputs: Record<string, string> = {
        "rev-parse --show-toplevel": `${projectRoot}\n`,
        "rev-parse --path-format=absolute --absolute-git-dir": `${gitDir}\n`,
        "rev-parse --path-format=absolute --git-common-dir": `${gitDir}\n`,
        "rev-parse HEAD": "0123456789abcdef0123456789abcdef01234567\n",
        "symbolic-ref -q HEAD": "refs/heads/main\n",
      };
      const runner: GitCommandRunner = {
        run(_cwd: string, args: string[]) {
          return { exitCode: 0, stdout: outputs[args.join(" ")]!, stderr: "" };
        },
      };
      return new GitWorkspaceResolver(runner).inspect(projectRoot, descriptor);
    };

    const lowerDriveProject = localProjectRoot.replace(/^([A-Z]):/, (_match, drive: string) => `${drive.toLowerCase()}:`);
    const lowerDriveGitDir = localGitDir.replace(/^([A-Z]):/, (_match, drive: string) => `${drive.toLowerCase()}:`);
    const canonicalDrive = resolveWith(localProjectRoot, localGitDir);
    const driftedDrive = resolveWith(lowerDriveProject, lowerDriveGitDir);
    assert.deepEqual(driftedDrive, canonicalDrive);

    const toUnc = (path: string): string => `\\\\localhost\\${path[0]}$${path.slice(2)}`;
    const uncProjectRoot = toUnc(localProjectRoot);
    const uncGitDir = toUnc(localGitDir);
    assert.equal(existsSync(uncProjectRoot), true);
    const firstUnc = resolveWith(uncProjectRoot, uncGitDir);
    const secondUnc = resolveWith(uncProjectRoot, uncGitDir);
    assert.deepEqual(secondUnc, firstUnc);
    assert.equal(firstUnc.kind, "git");
    if (firstUnc.kind === "git") {
      assert.equal(firstUnc.worktreeRoot, resolve(realpathSync.native(uncProjectRoot)));
      assert.equal(firstUnc.gitDir, resolve(realpathSync.native(uncGitDir)));
    }
  });

  it("fails closed when rev-parse returns a non-object HEAD", () => {
    root = mkdtempSync(join(tmpdir(), "memory-git-bad-head-"));
    const projectRoot = join(root, "checkout");
    const gitDir = join(projectRoot, ".git");
    mkdirSync(gitDir, { recursive: true });
    const outputs: Record<string, string> = {
      "rev-parse --show-toplevel": `${projectRoot}\n`,
      "rev-parse --path-format=absolute --absolute-git-dir": `${gitDir}\n`,
      "rev-parse --path-format=absolute --git-common-dir": `${gitDir}\n`,
      "rev-parse HEAD": "HEAD\n",
      "symbolic-ref -q HEAD": "refs/heads/main\n",
    };
    const runner: GitCommandRunner = {
      run(_cwd: string, args: string[]) {
        return { exitCode: 0, stdout: outputs[args.join(" ")]!, stderr: "" };
      },
    };

    assert.throws(
      () => new GitWorkspaceResolver(runner).inspect(projectRoot, descriptor),
      (error: unknown) => {
        assert.ok(error instanceof GitWorkspaceResolutionError);
        assert.equal(error.code, "GIT_PROBE_FAILED");
        assert.equal(error.reason, "MALFORMED_OUTPUT");
        return true;
      },
    );
  });

  it("fails closed when symbolic-ref returns a non-full ref", () => {
    root = mkdtempSync(join(tmpdir(), "memory-git-bad-ref-"));
    const projectRoot = join(root, "checkout");
    const gitDir = join(projectRoot, ".git");
    mkdirSync(gitDir, { recursive: true });
    const outputs: Record<string, string> = {
      "rev-parse --show-toplevel": `${projectRoot}\n`,
      "rev-parse --path-format=absolute --absolute-git-dir": `${gitDir}\n`,
      "rev-parse --path-format=absolute --git-common-dir": `${gitDir}\n`,
      "rev-parse HEAD": "0123456789abcdef0123456789abcdef01234567\n",
      "symbolic-ref -q HEAD": "main\n",
    };
    const runner: GitCommandRunner = {
      run(_cwd: string, args: string[]) {
        return { exitCode: 0, stdout: outputs[args.join(" ")]!, stderr: "" };
      },
    };

    assert.throws(
      () => new GitWorkspaceResolver(runner).inspect(projectRoot, descriptor),
      (error: unknown) => {
        assert.ok(error instanceof GitWorkspaceResolutionError);
        assert.equal(error.reason, "MALFORMED_OUTPUT");
        return true;
      },
    );
  });

  it("fails closed when a successful identity probe emits unexpected stderr", () => {
    root = mkdtempSync(join(tmpdir(), "memory-git-stderr-"));
    const projectRoot = join(root, "checkout");
    const gitDir = join(projectRoot, ".git");
    mkdirSync(gitDir, { recursive: true });
    const outputs: Record<string, string> = {
      "rev-parse --show-toplevel": `${projectRoot}\n`,
      "rev-parse --path-format=absolute --absolute-git-dir": `${gitDir}\n`,
      "rev-parse --path-format=absolute --git-common-dir": `${gitDir}\n`,
      "rev-parse HEAD": "0123456789abcdef0123456789abcdef01234567\n",
      "symbolic-ref -q HEAD": "refs/heads/main\n",
    };
    const runner: GitCommandRunner = {
      run(_cwd: string, args: string[]) {
        const key = args.join(" ");
        return {
          exitCode: 0,
          stdout: outputs[key]!,
          stderr: key === "rev-parse --show-toplevel" ? "warning: unexpected probe state\n" : "",
        };
      },
    };

    assert.throws(
      () => new GitWorkspaceResolver(runner).inspect(projectRoot, descriptor),
      (error: unknown) => {
        assert.ok(error instanceof GitWorkspaceResolutionError);
        assert.equal(error.code, "GIT_PROBE_FAILED");
        return true;
      },
    );
  });

  it("reports an unresolvable Git administrative path as a typed probe failure", () => {
    root = mkdtempSync(join(tmpdir(), "memory-git-bad-admin-path-"));
    const outputs: Record<string, string> = {
      "rev-parse --show-toplevel": `${root}\n`,
      "rev-parse --path-format=absolute --absolute-git-dir": `${join(root, "missing", ".git")}\n`,
    };
    const runner: GitCommandRunner = {
      run(_cwd: string, args: string[]) {
        return { exitCode: 0, stdout: outputs[args.join(" ")]!, stderr: "" };
      },
    };

    assert.throws(
      () => new GitWorkspaceResolver(runner).inspect(root!, descriptor),
      (error: unknown) => {
        assert.ok(error instanceof GitWorkspaceResolutionError);
        assert.equal(error.code, "GIT_PROBE_FAILED");
        assert.equal(error.reason, "PATH_CANONICALIZATION_FAILED");
        return true;
      },
    );
  });

  it("fails closed when the worktree Git directory is outside the common directory", () => {
    root = mkdtempSync(join(tmpdir(), "memory-git-outside-common-"));
    const projectRoot = join(root, "checkout");
    const gitDir = join(root, "administrative", "worktree");
    const gitCommonDir = join(root, "common");
    mkdirSync(projectRoot);
    mkdirSync(gitDir, { recursive: true });
    mkdirSync(gitCommonDir);
    const outputs: Record<string, string> = {
      "rev-parse --show-toplevel": `${projectRoot}\n`,
      "rev-parse --path-format=absolute --absolute-git-dir": `${gitDir}\n`,
      "rev-parse --path-format=absolute --git-common-dir": `${gitCommonDir}\n`,
      "rev-parse HEAD": "0123456789abcdef0123456789abcdef01234567\n",
      "symbolic-ref -q HEAD": "refs/heads/main\n",
    };
    const runner: GitCommandRunner = {
      run(_cwd: string, args: string[]) {
        return { exitCode: 0, stdout: outputs[args.join(" ")]!, stderr: "" };
      },
    };

    assert.throws(
      () => new GitWorkspaceResolver(runner).inspect(projectRoot, descriptor),
      (error: unknown) => {
        assert.ok(error instanceof GitWorkspaceResolutionError);
        assert.equal(error.reason, "GIT_DIR_OUTSIDE_COMMON_DIR");
        return true;
      },
    );
  });

  it("fails closed on every unexpected later-probe failure", () => {
    root = mkdtempSync(join(tmpdir(), "memory-git-later-failure-"));
    const projectRoot = join(root, "checkout");
    const gitDir = join(projectRoot, ".git");
    mkdirSync(gitDir, { recursive: true });
    const successes: Record<string, GitCommandResult> = {
      "rev-parse --show-toplevel": { exitCode: 0, stdout: `${projectRoot}\n`, stderr: "" },
      "rev-parse --path-format=absolute --absolute-git-dir": {
        exitCode: 0,
        stdout: `${gitDir}\n`,
        stderr: "",
      },
      "rev-parse --path-format=absolute --git-common-dir": {
        exitCode: 0,
        stdout: `${gitDir}\n`,
        stderr: "",
      },
      "rev-parse HEAD": {
        exitCode: 0,
        stdout: "0123456789abcdef0123456789abcdef01234567\n",
        stderr: "",
      },
      "symbolic-ref -q HEAD": { exitCode: 0, stdout: "refs/heads/main\n", stderr: "" },
    };
    const laterCommands = Object.keys(successes).slice(1);
    for (const failedCommand of laterCommands) {
      const runner: GitCommandRunner = {
        run(_cwd: string, args: string[]) {
          const key = args.join(" ");
          return key === failedCommand
            ? { exitCode: 128, stdout: "", stderr: "fatal: unexpected probe failure" }
            : successes[key]!;
        },
      };
      assert.throws(
        () => new GitWorkspaceResolver(runner).inspect(projectRoot, descriptor),
        (error: unknown) => {
          assert.ok(error instanceof GitWorkspaceResolutionError);
          assert.equal(error.code, "GIT_PROBE_FAILED");
          return true;
        },
        failedCommand,
      );
    }

    const whitespaceDetachedRunner: GitCommandRunner = {
      run(_cwd: string, args: string[]) {
        const key = args.join(" ");
        return key === "symbolic-ref -q HEAD"
          ? { exitCode: 1, stdout: " ", stderr: "" }
          : successes[key]!;
      },
    };
    assert.throws(
      () => new GitWorkspaceResolver(whitespaceDetachedRunner).inspect(projectRoot, descriptor),
      (error: unknown) => error instanceof GitWorkspaceResolutionError
        && error.code === "GIT_PROBE_FAILED",
      "symbolic-ref exit 1 must be exactly empty to mean detached HEAD",
    );
  });
});
