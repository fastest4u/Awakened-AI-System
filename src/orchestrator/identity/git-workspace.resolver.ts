import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { isAbsolute } from "node:path";
import { assertContainedPath, canonicalExistingDirectory } from "./canonical-path.js";
import type {
  ProjectDescriptorV1,
  ProjectId,
  VaultId,
  WorkspaceId,
  WorkspaceSnapshot,
} from "./contracts.js";

export interface GitCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface GitCommandRunner {
  run(cwd: string, args: string[]): GitCommandResult;
}

export class SpawnSyncGitCommandRunner implements GitCommandRunner {
  run(cwd: string, args: string[]): GitCommandResult {
    const result = spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      shell: false,
      windowsHide: true,
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    return {
      exitCode: result.status ?? 1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? result.error?.message ?? "",
    };
  }
}

export type GitWorkspaceResolutionErrorCode =
  | "GIT_PROBE_FAILED"
  | "GIT_WORKSPACE_NOT_READY";

export type GitWorkspaceResolutionReason =
  | "COMMAND_FAILED"
  | "GIT_DIR_OUTSIDE_COMMON_DIR"
  | "MALFORMED_OUTPUT"
  | "PATH_CANONICALIZATION_FAILED"
  | "UNBORN_HEAD"
  | "UNEXPECTED_STDERR";

export class GitWorkspaceResolutionError extends Error {
  constructor(
    readonly code: GitWorkspaceResolutionErrorCode,
    readonly reason: GitWorkspaceResolutionReason,
  ) {
    super(`${code}: ${reason}`);
    this.name = "GitWorkspaceResolutionError";
  }
}

const notRepositoryDiagnostic =
  /^fatal: not a git repository \(or any of the parent directories\): \.git(?:\r?\n)?$/;
const unbornHeadDiagnostic =
  /^fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree\.(?:\r?\n)?$/;

function parseSingleLineOutput(stdout: string): string {
  const value = stdout.endsWith("\r\n")
    ? stdout.slice(0, -2)
    : stdout.endsWith("\n")
      ? stdout.slice(0, -1)
      : stdout;
  if (value.length === 0 || /[\0\r\n]/.test(value)) {
    throw new GitWorkspaceResolutionError("GIT_PROBE_FAILED", "MALFORMED_OUTPUT");
  }
  return value;
}

function canonicalGitDirectory(stdout: string): string {
  const path = parseSingleLineOutput(stdout);
  if (!isAbsolute(path)) {
    throw new GitWorkspaceResolutionError("GIT_PROBE_FAILED", "MALFORMED_OUTPUT");
  }
  try {
    return canonicalExistingDirectory(path);
  } catch {
    throw new GitWorkspaceResolutionError("GIT_PROBE_FAILED", "PATH_CANONICALIZATION_FAILED");
  }
}

function parseHeadCommit(stdout: string): string {
  const headCommit = parseSingleLineOutput(stdout);
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(headCommit)) {
    throw new GitWorkspaceResolutionError("GIT_PROBE_FAILED", "MALFORMED_OUTPUT");
  }
  return headCommit;
}

function parseBranchRef(stdout: string): string {
  const branchRef = parseSingleLineOutput(stdout);
  const components = branchRef.split("/");
  const invalid = !branchRef.startsWith("refs/")
    || branchRef.endsWith(".")
    || branchRef.endsWith("/")
    || branchRef.includes("..")
    || branchRef.includes("@{")
    || branchRef.includes("//")
    || /[\u0000-\u0020\u007f~^:?*\[\\]/.test(branchRef)
    || components.some((component) => component.length === 0
      || component.startsWith(".")
      || component.endsWith(".lock"));
  if (invalid) {
    throw new GitWorkspaceResolutionError("GIT_PROBE_FAILED", "MALFORMED_OUTPUT");
  }
  return branchRef;
}

export function deriveGitWorkspaceId(
  projectId: ProjectId,
  gitCommonDir: string,
  gitDir: string,
): WorkspaceId {
  assertContainedPath(gitCommonDir, gitDir);
  const administrativeIdentity = gitDir.replace(/\\/g, "/");
  return createHash("sha256")
    .update("project-memory/workspace/v1\0", "utf8")
    .update(projectId, "utf8")
    .update("\0", "utf8")
    .update(administrativeIdentity, "utf8")
    .digest("hex") as WorkspaceId;
}

export function deriveNonGitWorkspaceId(projectId: ProjectId, vaultId: VaultId): WorkspaceId {
  return createHash("sha256")
    .update("project-memory/non-git-workspace/v1\0", "utf8")
    .update(projectId, "utf8")
    .update("\0", "utf8")
    .update(vaultId, "utf8")
    .digest("hex") as WorkspaceId;
}

export class GitWorkspaceResolver {
  constructor(private readonly runner: GitCommandRunner) {}

  inspect(projectRoot: string, descriptor: ProjectDescriptorV1): WorkspaceSnapshot {
    const topLevelResult = this.runner.run(projectRoot, ["rev-parse", "--show-toplevel"]);
    if (
      topLevelResult.exitCode === 128
      && topLevelResult.stdout.length === 0
      && notRepositoryDiagnostic.test(topLevelResult.stderr)
    ) {
      const workspaceRoot = canonicalExistingDirectory(projectRoot);
      return {
        kind: "non-git",
        workspaceRoot,
        workspaceId: deriveNonGitWorkspaceId(descriptor.projectId, descriptor.vaultId),
      };
    }
    if (topLevelResult.exitCode !== 0) {
      throw new GitWorkspaceResolutionError("GIT_PROBE_FAILED", "COMMAND_FAILED");
    }
    if (topLevelResult.stderr.length !== 0) {
      throw new GitWorkspaceResolutionError("GIT_PROBE_FAILED", "UNEXPECTED_STDERR");
    }

    const run = (args: string[]): string => {
      const result = this.runner.run(projectRoot, args);
      if (result.exitCode !== 0) {
        throw new GitWorkspaceResolutionError("GIT_PROBE_FAILED", "COMMAND_FAILED");
      }
      if (result.stderr.length !== 0) {
        throw new GitWorkspaceResolutionError("GIT_PROBE_FAILED", "UNEXPECTED_STDERR");
      }
      return result.stdout;
    };

    const worktreeRoot = canonicalGitDirectory(topLevelResult.stdout);
    const gitDir = canonicalGitDirectory(
      run(["rev-parse", "--path-format=absolute", "--absolute-git-dir"]),
    );
    const gitCommonDir = canonicalGitDirectory(
      run(["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    );
    const headResult = this.runner.run(projectRoot, ["rev-parse", "HEAD"]);
    const branchResult = this.runner.run(projectRoot, ["symbolic-ref", "-q", "HEAD"]);
    const detached = branchResult.exitCode === 1
      && branchResult.stdout.length === 0
      && branchResult.stderr.length === 0;
    let branchRef: string | null;
    if (detached) {
      branchRef = null;
    } else if (branchResult.exitCode !== 0) {
      throw new GitWorkspaceResolutionError("GIT_PROBE_FAILED", "COMMAND_FAILED");
    } else {
      if (branchResult.stderr.length !== 0) {
        throw new GitWorkspaceResolutionError("GIT_PROBE_FAILED", "UNEXPECTED_STDERR");
      }
      branchRef = parseBranchRef(branchResult.stdout);
    }
    if (
      headResult.exitCode === 128
      && branchRef !== null
      && /^(?:HEAD|HEAD\r?\n)$/.test(headResult.stdout)
      && unbornHeadDiagnostic.test(headResult.stderr)
    ) {
      throw new GitWorkspaceResolutionError("GIT_WORKSPACE_NOT_READY", "UNBORN_HEAD");
    }
    if (headResult.exitCode !== 0) {
      throw new GitWorkspaceResolutionError("GIT_PROBE_FAILED", "COMMAND_FAILED");
    }
    if (headResult.stderr.length !== 0) {
      throw new GitWorkspaceResolutionError("GIT_PROBE_FAILED", "UNEXPECTED_STDERR");
    }
    const headCommit = parseHeadCommit(headResult.stdout);
    let workspaceId: WorkspaceId;
    try {
      workspaceId = deriveGitWorkspaceId(descriptor.projectId, gitCommonDir, gitDir);
    } catch {
      throw new GitWorkspaceResolutionError("GIT_PROBE_FAILED", "GIT_DIR_OUTSIDE_COMMON_DIR");
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
}
