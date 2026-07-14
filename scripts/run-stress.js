import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const npmExecPath = process.env.npm_execpath;
const stressTestPath = fileURLToPath(new URL("../dist-test/tests/event-store.stress.test.js", import.meta.url));

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      stdio: "inherit",
      ...options,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

function propagateExit({ code, signal }) {
  if (signal !== null) {
    try {
      process.kill(process.pid, signal);
    } catch {
      process.exit(1);
    }
    return;
  }
  process.exit(code ?? 1);
}

async function main() {
  if (npmExecPath === undefined || npmExecPath.length === 0) {
    throw new Error("npm_execpath is required; run this gate through npm run test:stress");
  }
  const build = await run(process.execPath, [npmExecPath, "run", "test:build"]);
  if (build.code !== 0 || build.signal !== null) propagateExit(build);

  const stress = await run(process.execPath, [
    "--test",
    "--test-concurrency=1",
    "--test-reporter=spec",
    stressTestPath,
  ], {
    env: { ...process.env, MEMORY_EVENT_STRESS: "1" },
  });
  propagateExit(stress);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
