import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const npmExecPath = process.env.npm_execpath;
const stressTestPath = fileURLToPath(new URL("../dist-test/tests/lifecycle.stress.test.js", import.meta.url));

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

function exitFrom(result) {
  if (result.signal !== null) {
    try { process.kill(process.pid, result.signal); } catch { process.exit(1); }
    return;
  }
  process.exit(result.code ?? 1);
}

async function main() {
  if (typeof npmExecPath !== "string" || npmExecPath.length === 0) {
    throw new Error("npm_execpath is required; run this gate through npm run test:lifecycle-stress");
  }
  const build = await run(process.execPath, [npmExecPath, "run", "test:build"]);
  if (build.code !== 0 || build.signal !== null) exitFrom(build);
  const stress = await run(process.execPath, [
    "--test",
    "--test-concurrency=1",
    "--test-reporter=spec",
    stressTestPath,
  ], { env: { ...process.env, MEMORY_LIFECYCLE_STRESS: "1" } });
  exitFrom(stress);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
