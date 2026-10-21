import { parseCliArgs } from "../../src/cli/parse-args.js";
import {
  createOrchestratorAdminDependencies,
  runCliCommand,
} from "../../src/cli/run-command.js";

function send(value: unknown): void {
  if (process.send === undefined) throw new Error("IPC_UNAVAILABLE");
  process.send(value);
}

const [projectRoot, vaultRoot] = process.argv.slice(2);
if (projectRoot === undefined || vaultRoot === undefined) {
  throw new Error("UPGRADE_CHILD_ARGS_INVALID");
}

process.once("message", (message) => {
  if (message !== "go") throw new Error("UPGRADE_CHILD_PROTOCOL_INVALID");
  void (async () => {
    let stdout = "";
    let stderr = "";
    const code = await runCliCommand(parseCliArgs([
      "orchestrator-upgrade",
      "--project-root", projectRoot,
      "--vault", vaultRoot,
      "--apply",
    ]), {
      stdout(text) { stdout += text; },
      stderr(text) { stderr += text; },
    }, createOrchestratorAdminDependencies(
      new URL("../../src/workers/project-store.worker.js", import.meta.url),
    ));
    send({ type: "result", code, stdout, stderr });
    process.disconnect?.();
  })().catch((error: unknown) => {
    send({
      type: "failure",
      message: error instanceof Error ? error.message : "UPGRADE_CHILD_FAILED",
    });
    process.disconnect?.();
  });
});

send({ type: "ready" });
