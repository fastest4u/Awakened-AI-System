import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const evaluationTest = fileURLToPath(new URL(
  "../dist-test/tests/retrieval-evaluation.test.js",
  import.meta.url,
));

function runEvaluation() {
  const requested = process.argv[2] === undefined
    ? evaluationTest
    : resolve(root, process.argv[2]);
  if (requested !== evaluationTest) throw new Error("RETRIEVAL_EVALUATION_TARGET_INVALID");
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [
      "--test",
      "--test-concurrency=1",
      "--test-reporter=spec",
      evaluationTest,
    ], {
      cwd: root,
      shell: false,
      stdio: "inherit",
      env: { ...process.env, RETRIEVAL_EVALUATION_REPORT: "1" },
    });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => resolveRun({ code, signal }));
  });
}

function propagateExit(result) {
  if (result.signal !== null) {
    try {
      process.kill(process.pid, result.signal);
    } catch {
      process.exit(1);
    }
    return;
  }
  process.exit(result.code ?? 1);
}

runEvaluation().then(propagateExit).catch((error) => {
  console.error(error instanceof Error ? error.message : "RETRIEVAL_EVALUATION_FAILED");
  process.exit(1);
});
