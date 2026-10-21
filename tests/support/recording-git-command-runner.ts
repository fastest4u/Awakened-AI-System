import { spawnSync } from "node:child_process";
import { SpawnSyncGitCommandRunner, type GitCommandResult, type GitCommandRunner, type GitWorkspaceResolutionReason } from "../../src/orchestrator/identity/git-workspace.resolver.js";

const MAX_GIT_PROBES = 16;
const MAX_GIT_ARGV = 8;
const MAX_GIT_TEXT_CHARS = 8 * 1024;
export type GitProbeRecord = {
  readonly argv: readonly string[]; readonly cwd: string; readonly status: number | null;
  readonly stdout: string; readonly stderr: string;
  readonly spawnError: { readonly code: string | null; readonly message: string } | null;
};
export type GitProbeDiagnostic = {
  readonly phase: "bootstrap" | "binding"; readonly reason: GitWorkspaceResolutionReason | null;
  readonly probes: readonly GitProbeRecord[];
};
function boundedGitText(value: string): string {
  if (value.includes("\0")) throw new Error("FIXTURE_GIT_PROBE_NUL");
  return value.slice(0, MAX_GIT_TEXT_CHARS);
}
function gitOutput(value: string | Buffer | undefined): string {
  return boundedGitText(value === undefined ? "" : Buffer.isBuffer(value) ? value.toString("utf8") : value);
}
export class RecordingGitCommandRunner implements GitCommandRunner {
  readonly #records: GitProbeRecord[] = [];
  readonly #runner: SpawnSyncGitCommandRunner;
  constructor(gitSpawn: typeof spawnSync = spawnSync) {
    // Decorate the existing production boundary, preserving its overload and result.
    // Retry selection and all spawn options remain owned by the production runner.
    const recordingSpawn = ((...parameters: Parameters<typeof spawnSync>) => {
      const result = gitSpawn(...parameters);
      this.#record(String(parameters[2]?.cwd ?? ""), parameters[1] ?? [], result);
      return result;
    }) as typeof spawnSync;
    this.#runner = new SpawnSyncGitCommandRunner(recordingSpawn);
  }
  run(cwd: string, args: string[]): GitCommandResult {
    return this.#runner.run(cwd, args);
  }
  #record(cwd: string, args: readonly string[], result: ReturnType<typeof spawnSync>): void {
    const stdout = gitOutput(result.stdout), stderr = gitOutput(result.stderr);
    if (this.#records.length < MAX_GIT_PROBES) {
      const spawnError = result.error === undefined ? null : {
        code: typeof (result.error as NodeJS.ErrnoException).code === "string" ? boundedGitText((result.error as NodeJS.ErrnoException).code!) : null,
        message: boundedGitText(result.error.message),
      };
      this.#records.push(Object.freeze({ argv: Object.freeze(args.slice(0, MAX_GIT_ARGV).map(boundedGitText)),
        cwd: boundedGitText(cwd), status: result.status, stdout, stderr,
        spawnError: spawnError === null ? null : Object.freeze(spawnError) }));
    }
  }
  diagnostic(phase: GitProbeDiagnostic["phase"], reason: GitWorkspaceResolutionReason | null): GitProbeDiagnostic {
    return Object.freeze({ phase, reason, probes: Object.freeze([...this.#records]) });
  }
}
