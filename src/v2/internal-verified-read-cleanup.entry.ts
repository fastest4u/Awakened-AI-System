import { performance } from "node:perf_hooks";
import { releaseOwnedReadLock } from "../orchestrator/verified-read/cleanup.js";
import { decodeCleanupBootstrap, decodeCleanupReply } from "../orchestrator/verified-read/protocol.js";
import { inspectV2Build } from "./build-identity.js";

let received = false;
let closing = false;
function close(): void { closing = true; if (process.connected) process.disconnect(); }
if (!process.send || process.argv.length !== 2) { process.exitCode = 1; close(); }
else {
  process.once("disconnect", () => { if (!closing) process.exitCode = 1; });
  process.on("message", value => {
    if (received) { process.exitCode = 1; close(); return; }
    received = true;
    try {
      const started = performance.now();
      const bootstrap = decodeCleanupBootstrap(value);
      let measured = "";
      try { measured = inspectV2Build(import.meta.url); } catch { /* Unbundled entries must refuse. */ }
      const input = { ...bootstrap, remainingMs: Math.max(0, bootstrap.remainingMs - (performance.now() - started)) };
      const reply = releaseOwnedReadLock(input, measured);
      process.send!(decodeCleanupReply(reply), error => { if (error) process.exitCode = 1; close(); });
    } catch { process.exitCode = 1; close(); }
  });
}
