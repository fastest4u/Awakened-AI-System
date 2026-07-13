import { CliUsageError, parseCliArgs } from "./cli/parse-args.js";
import {
  createOrchestratorAdminDependencies,
  runCliCommand,
} from "./cli/run-command.js";

const WORKER_URL = new URL("./workers/project-store.worker.js", import.meta.url);

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));
  const exitCode = await runCliCommand(
    options,
    {
      stdout: (text) => { process.stdout.write(text); },
      stderr: (text) => { process.stderr.write(text); },
    },
    createOrchestratorAdminDependencies(WORKER_URL),
  );
  if (exitCode !== 0) process.exitCode = exitCode;
}

main().catch((error: unknown) => {
  if (error instanceof CliUsageError) {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: error.code,
      message: "Invalid command-line input",
    })}\n`);
    process.exitCode = 2;
    return;
  }
  console.error(error);
  process.exit(1);
});
